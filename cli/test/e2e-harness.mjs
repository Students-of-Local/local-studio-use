// Shared setup for end-to-end runs: the built extension in a throwaway headless Chromium,
// the native host the browser spawns, and the MCP server driven by a real MCP client.
// Own HOME, profile and socket directory, so it never touches an installed browser or a
// running bridge. `test/dom-bench/run.mjs` uses it; `e2e-bridge.test.mjs` keeps its own copy.
//
// Needs `npm run build` in cli/ and at the repo root (dist-chrome) and a Playwright Chromium
// (`npx playwright-core install chromium`).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const extensionDir = join(here, "..", "..", "dist-chrome");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms, what) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** What a CDP command fails with when its target closes before the reply. */
export const TARGET_CLOSED = "the target closed";

/** One CDP command over a target's websocket. */
export async function cdp(wsUrl, method, params = {}) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	try {
		const reply = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out${params.expression ? `: ${params.expression.slice(0, 120)}` : ""}`)), 15_000);
			ws.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id !== 1) return;
				clearTimeout(timer);
				resolve(msg);
			};
			// The target went away (a window the call itself closed): its reply never comes.
			ws.onclose = () => {
				clearTimeout(timer);
				reject(new Error(`${method}: ${TARGET_CLOSED}`));
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
		return reply.result;
	} finally {
		ws.close();
	}
}

/** True while any process of the group `pgid` is alive. */
function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/**
 * End a browser started with `detached: true` and every process in its group: SIGTERM (it saves its profile), then
 * SIGKILL after 5 s, and return only once no process of the group is left (or after 15 s, with a warning).
 */
export async function stopGroup(child) {
	const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
	if (process.platform === "win32") {
		child.kill();
		await exited;
		return;
	}
	const pgid = child.pid;
	const signal = (sig) => {
		try {
			process.kill(-pgid, sig);
		} catch {
			/* the group is gone */
		}
	};
	signal("SIGTERM");
	await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
	const deadline = Date.now() + 10_000;
	while (groupAlive(pgid) && Date.now() < deadline) {
		signal("SIGKILL");
		await new Promise((r) => setTimeout(r, 50));
	}
	await exited;
	if (groupAlive(pgid)) console.error(`stopGroup: processes of group ${pgid} are still alive after SIGKILL`);
}

function listen(server) {
	return new Promise((r) => server.listen(0, "127.0.0.1", r));
}

/**
 * Start everything. Returns the handle the callers use; `stop()` tears it all down. `name` is the MCP client and
 * session name; `onElicit`, when set, answers the server's elicitation requests.
 *
 * Pages are served from a path -> html map (`mount`). Two origins serve the same map, on two
 * ports, so a page can frame another origin: put `{{origin}}` (this origin) or `{{origin2}}`
 * (the other one) in html, each followed by a path.
 *
 * `extension` loads another build folder than dist-chrome (the store build, for e2e-store-sandbox.test.mjs), and
 * `chromiumArgs` go to Chromium before the first page.
 */
export async function startHarness({ name = "dom-bench", onElicit, chromiumArgs = [], extension = extensionDir } = {}) {
	const home = mkdtempSync(join(tmpdir(), "tabkyra-e2e-home-"));
	// Unix socket paths are capped near 104 bytes on macOS, so keep this one short.
	const socketDir = mkdtempSync("/tmp/tke2e-");
	const profile =
		process.platform === "darwin" ? join(home, "Library", "Application Support", "Chromium") : join(home, ".config", "chromium");
	mkdirSync(profile, { recursive: true });

	const env = () => ({
		...process.env,
		HOME: home,
		// Linux looks for browser profiles under XDG_CONFIG_HOME first; a runner may set it. The data, state and cache folders
		// stay in this HOME too, so the helper's thread mirror and caches never land in the real ones.
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		TABKYRA_SOCKET_DIR: socketDir,
		TABKYRA_AUTO_ALLOW: "1",
		TABKYRA_CLIENT_NAME: name,
		TABKYRA_SESSION: name,
	});

	/** path -> html */
	const store = new Map();
	/** Paths a page asked for that the store lacks: a case whose page 404s measured nothing. */
	const misses = [];
	let origin = "";
	let origin2 = "";
	/** What pages POSTed to `<base>/__state`, by base: a page's own record of what a task changed, kept after its tab closes. */
	const posted = new Map();
	const serve = (self) => (req, res) => {
		const path = req.url.split("?")[0];
		if (req.method === "POST" && path.endsWith("/__state")) {
			let body = "";
			req.on("data", (d) => {
				body += d;
			});
			req.on("end", () => {
				try {
					posted.set(path.slice(0, -"/__state".length), JSON.parse(body));
				} catch {}
				res.writeHead(204);
				res.end();
			});
			return;
		}
		const body = store.get(path);
		if (body === undefined) {
			// Only the browser's own requests are the page's: Chromium sends Sec-Fetch-* on every one, navigations too. Other
			// programs on the machine probe loopback ports (a local model finder asks every port for /v1/models), and their
			// requests are not the case's.
			if (path !== "/favicon.ico" && req.headers["sec-fetch-dest"] !== undefined) misses.push(path);
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const other = self === "a" ? origin2 : origin;
		// A file with its own type ({ type, body }, e.g. a PDF) is served as is.
		if (typeof body !== "string") {
			res.writeHead(200, { "content-type": body.type });
			res.end(body.body);
			return;
		}
		res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" });
		res.end(body.replaceAll("{{origin2}}", other).replaceAll("{{origin}}", self === "a" ? origin : origin2));
	};
	const serverA = createServer(serve("a"));
	const serverB = createServer(serve("b"));
	await Promise.all([listen(serverA), listen(serverB)]);
	origin = `http://127.0.0.1:${serverA.address().port}`;
	origin2 = `http://127.0.0.1:${serverB.address().port}`;

	let browser;
	let mcp;
	const stop = async () => {
		await mcp?.close().catch(() => {});
		// Chromium's zygote, renderers and utility processes outlive the browser process for a while and keep writing the
		// profile, so removing HOME after only the browser exited failed with ENOTEMPTY on CI. The browser leads its own
		// process group: stop the whole group and wait until none of it is left before removing anything.
		if (browser) await stopGroup(browser);
		serverA.close();
		serverB.close();
		rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		rmSync(socketDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	};

	try {
		// `install` writes the host manifest into the profile's NativeMessagingHosts.
		execFileSync(process.execPath, [cli, "install"], { env: env(), stdio: ["ignore", "inherit", "inherit"] });

		// Launch Playwright's Chromium without Playwright's CDP session: the extension drives
		// tabs through chrome.debugger, and a second automation client attached to every
		// target gets in its way. Targets are listed over the DevTools HTTP endpoint instead.
		browser = spawn(
			// TABKYRA_E2E_CHROMIUM: a Chromium already on disk, when Playwright's pinned build isn't downloaded.
			process.env.TABKYRA_E2E_CHROMIUM || chromium.executablePath(),
			[
				`--user-data-dir=${profile}`,
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--password-store=basic",
				"--remote-debugging-port=0",
				// A headless browser on a CI runner has no GPU, and its GPU process dies on the runner's sandbox, which stalls a page crashed on purpose.
				"--disable-gpu",
				...chromiumArgs,
				`--disable-extensions-except=${extension}`,
				`--load-extension=${extension}`,
				"about:blank",
			],
			// Its own process group (POSIX), so stop() can end every process it starts.
			{ env: env(), stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" },
		);
		let stderr = "";
		browser.stderr.on("data", (d) => {
			stderr += d;
		});
		const devtools = await until(() => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20_000, "Chromium to start");
		// Developer mode, set the way the extensions page does.
		const version = await (await fetch(`http://${devtools}/json/version`)).json();
		const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: "chrome://extensions" });
		const extPage = await until(
			async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.startsWith("chrome://extensions")),
			10_000,
			"chrome://extensions",
		);
		await until(
			async () =>
				(await cdp(extPage.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)", awaitPromise: true, returnByValue: true })).result?.value,
			10_000,
			"developer mode",
		);
		await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });

		// onElicit: the client answers the server's questions to the person (an upload, a site), as a person would.
		mcp = new Client({ name, version: "0.0.0" }, onElicit ? { capabilities: { elicitation: {} } } : undefined);
		if (onElicit) mcp.setRequestHandler(ElicitRequestSchema, onElicit);
		await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: env(), stderr: "inherit" }));

		/** Raw MCP call: the result with its text joined. Does not throw on a tool error. */
		const call = async (name, args = {}) => {
			const result = await mcp.callTool({ name, arguments: args });
			const text = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return { ok: !result.isError, text, content: result.content };
		};
		/** Call and throw on a tool error. */
		const tool = async (name, args = {}) => {
			const r = await call(name, args);
			assert.ok(r.ok, `${name} failed: ${r.text}`);
			return r.text;
		};
		const connected = () =>
			until(
				() => {
					try {
						return JSON.parse(execFileSync(process.execPath, [cli, "status", "--json"], { env: env(), encoding: "utf8" })).connected;
					} catch {
						return false;
					}
				},
				45_000,
				"the extension to reconnect",
			);

		const targets = async () => (await fetch(`http://${devtools}/json/list`)).json();
		/** The page target showing `urlPrefix` (default: any page on the first origin). */
		const pageTarget = async (urlPrefix = origin) => (await targets()).find((t) => t.type === "page" && t.url.startsWith(urlPrefix));
		/** Evaluate an expression in the main frame of the page at `urlPrefix`; awaits promises. */
		const evaluate = async (expression, urlPrefix) => {
			const target = await pageTarget(urlPrefix);
			assert.ok(target, `no page open at ${urlPrefix ?? origin}`);
			const r = await cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(`page evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
			return r.result.value;
		};

		return {
			origin,
			origin2,
			/** host:port of Chromium's DevTools HTTP endpoint (/json/new, /json/close). */
			devtools,
			home,
			socketDir,
			/** The built CLI and the environment its commands run with here (its HOME, socket folder). */
			cli,
			env,
			mcp,
			call,
			tool,
			connected,
			until,
			cdp,
			targets,
			pageTarget,
			evaluate,
			/** The last state the page under `/${id}` POSTed to `/${id}/__state`, or undefined. */
			posted: (id) => posted.get(`/${id}`),
			/** Register html (a string, or a map of path -> html or { type, body }) under `/${id}`; returns the entry URL. */
			misses,
			mount(id, html) {
				const files = typeof html === "string" ? { "/": html } : html;
				for (const [path, body] of Object.entries(files)) {
					const key = `/${id}${path === "/" ? "/" : path}`;
					store.set(key, typeof body === "string" ? body.replaceAll("{{base}}", `/${id}`) : body);
				}
				return `${origin}/${id}/`;
			},
			/** Navigate, waiting for the extension to connect first. */
			async go(url) {
				await connected();
				return tool("navigate", { url });
			},
			stop,
		};
	} catch (err) {
		await stop();
		throw err;
	}
}
