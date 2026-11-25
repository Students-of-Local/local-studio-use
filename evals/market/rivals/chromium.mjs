// A throwaway headless Chromium with its own profile (never a person's), optionally with one unpacked extension.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms, what) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			last = e;
		}
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

export async function cdp(wsUrl, method, params = {}) {
	const ws = new WebSocket(wsUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = rej;
	});
	try {
		const reply = await new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 15_000);
			ws.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id !== 1) return;
				clearTimeout(timer);
				res(msg);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
		return reply.result;
	} finally {
		ws.close();
	}
}

export async function launchChromium({ extension, env = {}, home } = {}) {
	const root = home ?? mkdtempSync(join(process.env.TMPDIR || "/tmp", "market-chrome-"));
	const profile = join(root, "profile");
	const args = [
		`--user-data-dir=${profile}`,
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		"--use-mock-keychain",
		"--password-store=basic",
		"--remote-debugging-port=0",
		"--disable-gpu",
		...(extension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []),
		"about:blank",
	];
	const child = spawn(process.env.MARKET_CHROMIUM || chromium.executablePath(), args, { env: { ...process.env, HOME: root, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const devtools = await until(() => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20_000, "Chromium to start");
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const targets = async () => (await fetch(`http://${devtools}/json/list`)).json();
	const evaluate = async (expression, urlPrefix) => {
		const t = (await targets()).find((x) => x.type === "page" && x.url.startsWith(urlPrefix));
		if (!t) throw new Error(`no page at ${urlPrefix}`);
		const r = await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		return r.result.value;
	};
	return {
		root,
		devtools,
		browserWs: version.webSocketDebuggerUrl,
		targets,
		evaluate,
		send: (method, params) => cdp(version.webSocketDebuggerUrl, method, params),
		async stop() {
			child.kill();
			await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
			if (!home) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		},
	};
}

/** The extension id Chromium derives from a manifest `key`. */
export async function extensionIdFromKey(key) {
	const { createHash } = await import("node:crypto");
	const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}
