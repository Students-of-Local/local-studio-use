// The first run of the side panel on Local Studio, end to end, from an empty HOME: `tychicus install` and
// `tychicus install --local-studio` into a throwaway HOME, the built extension in a throwaway headless Chromium, a
// stand-in Eukhe daemon on its socket, and the panel opened with nothing set up. The welcome shows no key field, the
// default model is Local Studio's, and "read this page" runs as a Eukhe session: the stand-in's turn starts the
// `tychicus` MCP entry the install wrote (as Eukhe would), reads the current tab through it, and answers with what the
// page says. Any key prompt, any password field, any pairing code, or a wrong answer fails the run.
//
// Needs `npm run build` in cli/ and the extension in dist-chrome without a version bump:
//   TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=$PWD/dist-chrome npm run build   (repo root)
// and a Playwright Chromium (`npx playwright-core install chromium`).
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sleep, startHarness } from "./e2e-harness.mjs";
import { startFakeEukhe } from "./helpers/fake-eukhe.mjs";

const PANEL = `chrome-extension://${extensionId.id}/sidepanel.html`;
const SECRET = "The heron flies at dawn over Lake Tychicus";
const PAGE = `<!doctype html><title>Heron notes</title><main><h1>Field notes</h1><p>${SECRET}.</p></main>`;

/** Wait for `fn` to return something truthy; an assertion it throws fails the run at once (the harness's until retries). */
async function waitFor(fn, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		let value;
		try {
			value = await fn();
		} catch (err) {
			if (err instanceof assert.AssertionError) throw err;
		}
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

/** Anything that asks the person for a key or a pairing code, as the panel's document shows it now. */
const ASKS = `(() => {
	const found = [];
	const walk = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) walk(el.shadowRoot);
			const tag = el.tagName.toLowerCase();
			if (tag === "api-key-prompt-dialog" || tag === "api-key-dialog") found.push(tag);
			if (tag === "input" && el.type === "password") found.push("password field");
		}
	};
	walk(document);
	const text = document.body?.innerText ?? "";
	for (const m of text.matchAll(/(pairing code|enter (the|this) code|api key required|add an api key)/gi)) found.push(m[0]);
	return found;
})()`;

test("first run on Local Studio: no key asked, and 'read this page' answers from the page", { skip: process.platform === "win32" && "Local Studio is not on Windows yet", timeout: 180_000 }, async (t) => {
	// The daemon socket, set before the browser starts so the host Chrome spawns inherits it.
	const sockets = mkdtempSync(join(tmpdir(), "eu-"));
	t.after(() => rmSync(sockets, { recursive: true, force: true }));
	const socketPath = join(sockets, "daemon.sock");
	const saved = process.env.EUKHE_DAEMON_SOCKET;
	process.env.EUKHE_DAEMON_SOCKET = socketPath;
	t.after(() => {
		if (saved === undefined) delete process.env.EUKHE_DAEMON_SOCKET;
		else process.env.EUKHE_DAEMON_SOCKET = saved;
	});

	let h;
	const prompts = [];
	const toolCalls = [];
	const daemon = await startFakeEukhe({
		path: socketPath,
		// The stand-in model: it does what a model given the `tychicus` tools would do with "read this page".
		turn: async (turn) => {
			prompts.push(turn.message);
			const settings = JSON.parse(readFileSync(join(h.home, ".eukhe", "settings.json"), "utf8"));
			const entry = settings.mcpServers?.tychicus;
			assert.ok(entry, "install --local-studio wrote the tychicus entry");
			const mcp = new Client({ name: "eukhe-standin", version: "0.0.0" });
			await mcp.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: h.env(), stderr: "inherit" }));
			try {
				const call = async (name, args) => {
					toolCalls.push(name);
					const r = await mcp.callTool({ name, arguments: args });
					return { content: r.content, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: r.isError };
				};
				const url = /Current tab: .*?(https?:\/\/\S+)/.exec(turn.message)?.[1];
				await turn.delta("Reading the page. ");
				let text = "";
				if (url) {
					const r = await turn.tool("navigate", { url }, () => call("navigate", { url }));
					assert.ok(!r?.isError, `navigate failed: ${r?.text}`);
				}
				await turn.tool("get_page_text", {}, async () => {
					const r = await call("get_page_text", {});
					text = r.text;
					return r;
				});
				const said = text.match(/The heron[^.]*/)?.[0];
				await turn.delta(said ? `The page says: ${said}.` : `I could not read the page: ${text.slice(0, 200)}`);
			} finally {
				await mcp.close().catch(() => {});
			}
		},
	});
	t.after(() => daemon.close());

	h = await startHarness({ name: "eukhe-e2e" });
	t.after(() => h.stop());

	// The empty HOME gets what a person's would: the host (startHarness ran `install`) and the Local Studio entry.
	execFileSync(process.execPath, [h.cli, "install", "--local-studio"], { env: h.env(), stdio: ["ignore", "inherit", "inherit"] });
	const settings = JSON.parse(readFileSync(join(h.home, ".eukhe", "settings.json"), "utf8"));
	assert.deepEqual(settings.mcpServers.tychicus.args.slice(-2), ["--profile", "small"]);
	assert.deepEqual(readdirSync(join(h.home, ".local-studio", "plugins")).sort(), ["tychicus-browser", "tychicus-computer"]);

	// The page to read, open in a tab.
	const page = h.mount("heron", PAGE);
	const browserWs = (await (await fetch(`http://${h.devtools}/json/version`)).json()).webSocketDebuggerUrl;
	const { targetId: pageTarget } = await h.cdp(browserWs, "Target.createTarget", { url: page });
	await h.connected();

	// The panel, as on first run: nothing seeded, no key anywhere.
	const version = await (await fetch(`http://${h.devtools}/json/version`)).json();
	const { targetId } = await h.cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: PANEL });
	const panel = async (expression) => {
		const target = (await h.targets()).find((x) => x.id === targetId);
		const r = await h.cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const asks = [];
	const watch = async () => {
		const found = await panel(ASKS).catch(() => []);
		for (const f of found) if (!asks.includes(f)) asks.push(f);
		// Fail at once: a key prompt would sit there until the timeout.
		if (asks.length) throw new assert.AssertionError({ message: `the panel asked for a key or a pairing code: ${JSON.stringify(asks)}` });
	};

	// The welcome, in its Local Studio form: chat now, keys one link away.
	await waitFor(async () => (await watch(), panel(`!!document.querySelector("welcome-setup-dialog")`)), 30_000, "the welcome");
	const welcome = await panel(`document.querySelector("welcome-setup-dialog").innerText`);
	assert.match(welcome, /Runs on the Local Studio app/);
	assert.match(welcome, /Use an API key instead/);
	await panel(`[...document.querySelector("welcome-setup-dialog").querySelectorAll("button")].find((b) => b.innerText.trim() === "Chat here").click(), true`);
	await waitFor(async () => (await watch(), panel(`!document.querySelector("welcome-setup-dialog")`)), 10_000, "the welcome to close");

	// The model button names a Local Studio model, local first.
	await waitFor(async () => (await watch(), panel(`!!document.querySelector("textarea")?.placeholder?.includes("Ask about this page")`)), 20_000, "the composer");
	await waitFor(async () => (await watch(), /LFM2\.5 8B \(local\)/.test(await panel(`document.body.innerText`))), 20_000, "the Local Studio model on the model button");

	// The person is looking at the page: its tab is the active one (a real side panel sits beside it; here the panel is
	// a tab of its own, now in the background). Sending shares the active tab, as from the side panel.
	await h.cdp(browserWs, "Target.activateTarget", { targetId: pageTarget });

	// "read this page", typed and sent as a person would.
	await panel(`(() => {
		const box = document.querySelector("textarea");
		box.focus();
		const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
		set.call(box, "read this page");
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);

	try {
		await waitFor(
			async () => {
				await watch();
				return (await panel(`document.body.innerText`)).includes(`The page says: ${SECRET}.`);
			},
			90_000,
			"the answer from the page",
		);
	} catch (err) {
		if (asks.length) throw err;
		const shown = await panel(`document.body.innerText`).catch((e) => String(e));
		throw new Error(`${err.message}\nPanel:\n${shown}\nDaemon commands: ${JSON.stringify(daemon.commands.map((c) => c.type))}\nPrompts: ${JSON.stringify(prompts)}\nTools: ${JSON.stringify(toolCalls)}`);
	}
	await watch();

	assert.deepEqual(asks, [], "no key prompt, password field or pairing code at any point");
	assert.equal(prompts.length, 1, "one turn");
	assert.match(prompts[0], /read this page/);
	assert.match(prompts[0], new RegExp(`Current tab: Heron notes .*${page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the tab the person is on went with the prompt");
	assert.ok(toolCalls.includes("get_page_text"), "the page was read through the installed tychicus entry");
	// One Eukhe session for the chat, attached before the prompt, never a gateway client.
	const kinds = daemon.commands.map((c) => c.type);
	const chat = daemon.commands.filter((c) => c.type === "create" && c.config?.provider === "llamacpp");
	assert.equal(chat.length, 1, `one chat session: ${JSON.stringify(kinds)}`);
	assert.deepEqual(chat[0].env, { TYCHICUS_PROFILE: "small" }, "a local model's session asks for the small tool profile");
	const attach = daemon.commands.findIndex((c) => c.type === "attach");
	assert.ok(attach >= 0 && attach < daemon.commands.findIndex((c) => c.type === "prompt"), "attached before the prompt");
	assert.ok(daemon.commands.filter((c) => c.type === "attach").every((c) => c.clientKind === "interactive"));
});
