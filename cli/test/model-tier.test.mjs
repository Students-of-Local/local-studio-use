// "Match the model" site access (docs/decisions.md, D60): which tier a model name gets, which tier an MCP session
// reports, and that the bridge hello carries it. Local Studio's Rust copy of the rules gives the same 45 answers.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configuredModel, launchOf, modelFlag, modelTier, sessionTier } from "../src/model-tier.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const F = "frontier";
const S = "small";
const U = "unknown";
const CASES = [
	["claude-opus-5-5", F],
	["opus", F],
	["opus[1m]", F],
	["sonnet", F],
	["haiku", S],
	["claude-haiku-4-5-20251001", S],
	["claude-sonnet-4-5", S],
	["claude-sonnet-4-6", F],
	["claude-3-7-sonnet-latest", S],
	["claude-fable-5-2", F],
	["anthropic/claude-opus-4-5", F],
	["gpt-6.1-sol", F],
	["gpt-5.6-sol", F],
	["gpt-5.2-codex", F],
	["gpt-5.1-codex", S],
	["gpt-5", S],
	["gpt-5-mini", S],
	["gpt-4o", S],
	["gpt-oss-120b", S],
	["o3", U],
	["gemini-3-pro-preview", F],
	["gemini-3-flash", F],
	["gemini-3.1-flash-lite", S],
	["gemini-2.5-pro", S],
	["grok-4.5", F],
	["grok-4", S],
	["grok-code-fast-1", U],
	["deepseek-v4-pro", F],
	["deepseek-v3.2", S],
	["deepseek-r1", U],
	["kimi-k3", F],
	["kimi-k2.5", S],
	["glm-5.3", F],
	["glm-5", S],
	["minimax-m3", F],
	["MiniMax-M2.7", S],
	["qwen3.8-max", F],
	["qwen3.8-27b", S],
	["qwen3-coder:30b", S],
	["qwen3-coder-480b-a35b", S],
	["llama3.3:70b", S],
	["fv-smoke-lfm3-1.7b", S],
	["mistral-large-3", S],
	["devstral-2", S],
	["mystery-model", U],
];

test("modelTier gives the 45 agreed answers", () => {
	assert.equal(CASES.length, 45);
	const wrong = CASES.filter(([model, want]) => modelTier(model) !== want).map(([model, want]) => `${model}: got ${modelTier(model)}, want ${want}`);
	assert.deepEqual(wrong, []);
});

test("modelTier: a size under 100B is small whatever the family, and active-parameter tokens don't count", () => {
	assert.equal(modelTier("qwen3.8-max-8x7b"), S, "8x7b is 56B");
	assert.equal(modelTier("kimi-k3-a3b"), F, "a3b is active parameters, not size");
	assert.equal(modelTier("gemini-3-e4b"), F, "e4b starts with a letter");
	assert.equal(modelTier("glm-5.3-355b"), F, "355B is not small");
	assert.equal(modelTier("claude-opus-4-5-20251101"), F, "a date ends the version");
});

test("sessionTier: a named model wins, then the small profile, then Claude Code and Codex; the rest are unknown", () => {
	assert.deepEqual(sessionTier({ model: "claude-haiku-4-5", clientName: "claude-code" }), { tier: S, model: "claude-haiku-4-5" });
	assert.deepEqual(sessionTier({ model: "gpt-6.1-sol", clientName: "mystery" }), { tier: F, model: "gpt-6.1-sol" });
	for (const name of ["claude-code", "claude-ai", "claude", "codex", "codex-mcp-client", "codex_cli", "Claude-Code"]) assert.deepEqual(sessionTier({ clientName: name }), { tier: F }, name);
	assert.deepEqual(sessionTier({ clientName: "claude-code", small: true }), { tier: S }, "a local model under Claude Code asks");
	assert.deepEqual(sessionTier({ clientName: "LM Studio", small: true }), { tier: S });
	assert.deepEqual(sessionTier({ clientName: "cursor-vscode" }), { tier: U });
	assert.deepEqual(sessionTier({}), { tier: U });
	assert.deepEqual(sessionTier({ model: "  ", clientName: "codex" }), { tier: F }, "a blank model names none");
});

test("sessionTier: Claude Code and Codex on a small or unknown model are not frontier", () => {
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: "haiku" }), { tier: S, model: "haiku" }, "claude --model haiku");
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: "claude-haiku-4-5" }), { tier: S, model: "claude-haiku-4-5" });
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: "opus" }), { tier: F, model: "opus" });
	assert.deepEqual(sessionTier({ clientName: "codex", clientModel: "gpt-5.1-codex-mini" }), { tier: S, model: "gpt-5.1-codex-mini" });
	assert.deepEqual(sessionTier({ clientName: "claude-code", baseUrl: "http://127.0.0.1:11434" }), { tier: U }, "a local endpoint");
	assert.deepEqual(sessionTier({ clientName: "claude-code", baseUrl: "not a url" }), { tier: U });
	assert.deepEqual(sessionTier({ clientName: "claude-code", baseUrl: "https://api.anthropic.com" }), { tier: F });
	assert.deepEqual(sessionTier({ clientName: "codex", baseUrl: "https://api.openai.com/v1" }), { tier: F });
	assert.deepEqual(sessionTier({ clientName: "codex", baseUrl: "http://127.0.0.1:11434/v1" }), { tier: U }, "Codex on a local OpenAI-style endpoint");
	assert.deepEqual(sessionTier({ clientName: "cursor-vscode", clientModel: "opus" }), { tier: U }, "only Claude Code and Codex report a launch model");
	assert.equal(modelFlag(["claude", "--model", "haiku"]), "haiku");
	assert.equal(modelFlag(["codex", "exec", "-m", "gpt-6.1-sol"]), "gpt-6.1-sol");
	assert.equal(modelFlag(["claude", "--model=sonnet"]), "sonnet");
	assert.equal(modelFlag(["claude", "--model", "--print"]), undefined);
	assert.equal(modelFlag(["node", "server.js"]), undefined);
});

test("sessionTier: off the vendor's endpoint a frontier name proves nothing, and a small one stays small", () => {
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: "opus", baseUrl: "http://127.0.0.1:4000" }), { tier: U, model: "opus" });
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: "haiku", baseUrl: "http://127.0.0.1:4000" }), { tier: S, model: "haiku" });
	assert.deepEqual(sessionTier({ clientName: "codex", clientModel: "gpt-6.1-sol", local: true }), { tier: U, model: "gpt-6.1-sol" }, "codex --oss");
	assert.deepEqual(sessionTier({ clientName: "codex", local: true }), { tier: U });
	assert.deepEqual(sessionTier({ clientName: "codex", clientModel: "gpt-oss:20b", local: true }), { tier: S, model: "gpt-oss:20b" });
});

test("launchOf: walks up to three processes for --model and --oss, and stops at an unreadable one", () => {
	const table = new Map([
		[10, { ppid: 9, args: ["sh", "-c", "local-studio-browser mcp"] }],
		[9, { ppid: 8, args: ["node", "/usr/lib/codex.js", "--oss"] }],
		[8, { ppid: 1, args: ["codex", "-m", "gpt-oss:20b"] }],
		[20, { ppid: 19, args: ["node", "cli.js", "--model", "haiku"] }],
		[30, { ppid: 29, args: ["a"] }],
		[29, { ppid: 28, args: ["b"] }],
		[28, { ppid: 27, args: ["c"] }],
		[27, { ppid: 1, args: ["claude", "--model", "haiku"] }],
	]);
	const read = (pid) => table.get(pid);
	assert.deepEqual(launchOf(10, read), { model: "gpt-oss:20b", local: true });
	assert.deepEqual(launchOf(20, read), { model: "haiku", local: false });
	assert.deepEqual(launchOf(30, read), { local: false }, "a fourth ancestor is too far to be the agent");
	assert.deepEqual(launchOf(40, read), { local: false });
	assert.deepEqual(launchOf(1, read), { local: false });
});

test("configuredModel: Claude Code settings in precedence order, Codex config.toml top-level keys", () => {
	assert.deepEqual(configuredModel("claude", [undefined, '{"model":"haiku"}', '{"model":"opus"}']), { model: "haiku", local: false });
	assert.deepEqual(configuredModel("claude", ["not json", '{"env":{}}', '{"model":"opus"}']), { model: "opus", local: false });
	assert.deepEqual(configuredModel("claude", [undefined, undefined, undefined]), { local: false });
	assert.deepEqual(configuredModel("codex", ['model = "gpt-5.1-codex-mini"\n']), { model: "gpt-5.1-codex-mini", local: false });
	assert.deepEqual(configuredModel("codex", ['model = "qwen3"\nmodel_provider = "ollama"\n']), { model: "qwen3", local: true });
	assert.deepEqual(configuredModel("codex", ["oss = true\n"]), { local: true });
	assert.deepEqual(configuredModel("codex", ['[profiles.fast]\nmodel = "gpt-5.1-codex-mini"\n']), { local: false }, "a profile table is not the default");
	assert.deepEqual(configuredModel("codex", ['model = "gpt-6.1-sol" # main\nmodel_provider = "openai"\n']), { model: "gpt-6.1-sol", local: false });
	assert.deepEqual(sessionTier({ clientName: "claude-code", clientModel: configuredModel("claude", ['{"model":"haiku"}']).model }), { tier: S, model: "haiku" });
});

// ---- the hello the MCP server sends -------------------------------------------------------------

let root;
before(() => {
	root = mkdtempSync(join(tmpdir(), "local-studio-tier-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/** A fake host in `dir`: `hello` is the first frame a client sends it. */
async function fakeHost(dir, extensionConnected = false) {
	chmodSync(dir, 0o700);
	const path = join(dir, `${process.pid}.sock`);
	let gotHello;
	const hello = new Promise((resolve) => {
		gotHello = resolve;
	});
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32LE(0)) return;
			gotHello(JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString("utf8")));
			socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected }));
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	return { hello, close: () => server.close() };
}

/** Start `mcp` as client `name` against a fake host and return the first frame it sends: its hello. */
async function helloFrom(name, env = {}, { settings, launch } = {}) {
	const dir = mkdtempSync(join(root, "sock-"));
	const home = join(dir, "home");
	mkdirSync(home);
	if (settings) {
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
	}
	const wrapper = join(dir, "agent.mjs");
	writeFileSync(
		wrapper,
		`import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(cli)}, "mcp"], { stdio: "inherit" });\nchild.on("exit", (code) => process.exit(code ?? 0));\nprocess.on("SIGTERM", () => child.kill());\n`,
	);
	const { hello, close } = await fakeHost(dir);
	const client = new Client({ name, version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: launch ? [wrapper, ...launch] : [cli, "mcp"],
				env: { HOME: home, PATH: dirname(process.execPath), LOCAL_STUDIO_BROWSER_SOCKET_DIR: dir, ...env },
				stderr: "ignore",
			}),
		);
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("no hello within 10 s")), 10000);
		});
		return await Promise.race([hello, timeout]).finally(() => clearTimeout(timer));
	} finally {
		await client.close().catch(() => {});
		close();
	}
}

test("the bridge hello carries the session's tier, and the model when one is named", async () => {
	const claude = await helloFrom("claude-code");
	assert.equal(claude.type, "hello");
	assert.equal(claude.client.tier, F);
	assert.equal(claude.client.model, undefined);
	const haiku = await helloFrom("claude-code", { LOCAL_STUDIO_BROWSER_MODEL: "claude-haiku-4-5" });
	assert.equal(haiku.client.tier, S);
	assert.equal(haiku.client.model, "claude-haiku-4-5");
	const inherited = await helloFrom("some-client", { LOCAL_STUDIO_BROWSER_MODEL: "gpt-6.1-sol" });
	assert.equal(inherited.client.tier, F, "LOCAL_STUDIO_BROWSER_MODEL is read too");
	assert.equal((await helloFrom("LM Studio")).client.tier, S, "a local-model client is small");
	assert.equal((await helloFrom("codex-mcp-client", { LOCAL_STUDIO_BROWSER_LOCAL_MODEL: "1" })).client.tier, S);
	assert.equal((await helloFrom("some-client")).client.tier, U);
});

test("the hello rates Claude Code by its --model launch flag and its settings.json model", async () => {
	const flag = await helloFrom("claude-code", {}, { launch: ["--model", "haiku"] });
	assert.equal(flag.client.tier, S, "claude --model haiku");
	assert.equal(flag.client.model, "haiku");
	assert.equal((await helloFrom("claude-code", {}, { launch: ["--model", "opus"] })).client.tier, F);
	const settings = await helloFrom("claude-code", {}, { settings: { model: "haiku" } });
	assert.equal(settings.client.tier, S, "model: haiku in ~/.claude/settings.json");
	assert.equal((await helloFrom("claude-code", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" }, { launch: ["--model", "opus"] })).client.tier, U);
});

test("the hello marks a remote or scoped session, so the extension never runs it in Yolo, and no other", async () => {
	const { build } = await import("esbuild");
	const out = join(root, "mcp-remote.mjs");
	await build({ entryPoints: [join(dirname(cli), "..", "src", "mcp.ts")], bundle: true, platform: "node", format: "esm", outfile: out, loader: { ".md": "text", ".pub": "text" }, logLevel: "silent" });
	const { createMcpServer } = await import(out);
	const saved = process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
	try {
		for (const [options, remote] of [[{ remote: true }, true], [{ allowedTools: new Set(["read_page"]) }, true], [{}, undefined]]) {
			const dir = mkdtempSync(join(root, "sock-"));
			const host = await fakeHost(dir, true);
			process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR = dir;
			const { client } = createMcpServer({ session: "one", ...options });
			try {
				await client.connect();
				assert.equal((await host.hello).client.remote, remote, JSON.stringify(options));
			} finally {
				client.close();
				host.close();
			}
		}
	} finally {
		if (saved === undefined) delete process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
		else process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR = saved;
	}
});
