// Computer use through the connector: off unless a token or grant names it, only the tools its scopes allow and this repo's
// list names, and always through `local-studio-computer mcp --connector`, which is what makes the helper treat the caller as remote.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "local-studio-computer-"));
const bin = join(root, "bin");
mkdirSync(bin);
symlinkSync(process.execPath, join(bin, "node"));
const log = join(root, "helper.log");
// What local-studio-computer answers `hands/grants` with when macOS hasn't allowed the app it runs under.
const MISSING = {
	grant: "accessibility",
	message: "macOS hasn't allowed Terminal to use Accessibility, so local-studio-computer can't read or act on windows",
	suggestion: "Ask the person to open System Settings > Privacy & Security > Accessibility and turn on Terminal (/System/Applications/Utilities/Terminal.app). Then try again.",
};
const helper = join(bin, "fake-spaces");
writeFileSync(
	helper,
	`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const seen = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "LOCAL_STUDIO_BROWSER_DIR", "FAKE_LEAK"].map((k) => [k, process.env[k]]));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: seen }) + "\\n");
const tool = (name, properties = {}, required = []) => ({ name, description: name + " it", inputSchema: { type: "object", properties, required } });
const tools = [
	tool("windows"),
	tool("snapshot", { app: { type: "string", description: "App name" }, interactive: { type: "boolean" } }),
	tool("click", { ref: { type: "string" } }, ["ref"]),
	tool("open", { app: { type: "string" }, targets: { type: "array", items: { type: "string" } } }, ["app"]),
	tool("run_steps", { steps: { type: "array", items: { type: "object" } } }, ["steps"]),
	tool("lend", { app: { type: "string" } }),
	tool("brand_new_verb"),
];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
	if (m.method === "initialize") return reply({ serverInfo: { name: process.env.FAKE_SERVER_NAME ?? "local-studio-connector" } });
	if (m.method === "tools/list") return reply({ tools });
	if (m.method === "hands/grants") {
		if (process.env.FAKE_GRANTS === "hang") return;
		if (process.env.FAKE_GRANTS === "exit") process.exit(4);
		if (process.env.FAKE_GRANTS === "bare") return reply({ missing: [{ message: "screen capture is off" }] });
		if (process.env.FAKE_GRANTS === "rows") return reply({ missing: [], grants: [{ name: "Accessibility", ok: true, text: "on" }, { name: "Screen Recording", ok: false }, { name: 3 }] });
		if (process.env.FAKE_GRANTS === "missing") return reply({ missing: [${JSON.stringify(MISSING)}] });
		return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found: hands/grants" } }) + "\\n");
	}
	appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params) + "\\n");
	if (m.params.name === "click") process.exit(3);
	reply({ content: [{ type: "text", text: "did " + m.params.name }], isError: false });
});
`,
);
chmodSync(helper, 0o755);

const base = { HOME: join(root, "home"), PATH: bin, NO_COLOR: "1", LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(root, "sock"), LOCAL_STUDIO_BROWSER_DIR: join(root, "config"), LOCAL_STUDIO_BROWSER_NO_UPDATE_CHECK: "1" };
mkdirSync(base.HOME, { recursive: true });
mkdirSync(base.LOCAL_STUDIO_BROWSER_SOCKET_DIR, { mode: 0o700 });
const servers = [];

function token(name, scopes) {
	const r = spawnSync(process.execPath, [cli, "token", "create", name, "--scope", scopes], { env: base, encoding: "utf8" });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	return /tkr_[A-Za-z0-9_-]+/.exec(r.stdout + r.stderr)[0];
}

function serve(extra, args = []) {
	const server = spawn(process.execPath, [cli, "serve", "--port", "0", ...args], { env: { ...base, ...extra } });
	servers.push(server);
	return new Promise((resolve, reject) => {
		let out = "";
		server.stdout.on("data", (d) => {
			out += d;
			const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
			if (m) resolve(m[0]);
		});
		server.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`serve printed no URL: ${out}`)), 15_000);
	});
}

async function connect(url, secret) {
	const client = new Client({ name: "computer-test", version: "0.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
	return client;
}

const computerTools = async (client) => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("computer_")).sort();
let withHelper;

before(async () => {
	withHelper = await serve({ LOCAL_STUDIO_COMPUTER_BIN: helper });
});

const locals = [];

after(async () => {
	// A failed assertion skips a test's own close; a stdio server left open would keep this run alive.
	await Promise.all(locals.map((c) => c.close().catch(() => {})));
	for (const s of servers) s.kill();
	rmSync(root, { recursive: true, force: true });
});

test("a session with no computer scope has no computer tools and starts no helper", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("browser-only", "browser.read"));
	assert.deepEqual(await computerTools(client), []);
	assert.equal(existsSync(log), false);
	await client.close();
});

test("computer.read sees reading tools only, through the helper's connector mode", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("looks", "computer.read"));
	assert.deepEqual(await computerTools(client), ["computer_snapshot", "computer_status", "computer_windows"]);
	const answer = await client.callTool({ name: "computer_snapshot", arguments: { app: "TextEdit", interactive: true } });
	assert.equal(answer.content[0].text, "did snapshot");
	const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines[0].argv, ["mcp", "--connector"]);
	assert.deepEqual(lines[1], { name: "snapshot", arguments: { app: "TextEdit", interactive: true } });
	const refused = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(refused.isError, true);
	assert.doesNotMatch(readFileSync(log, "utf8"), /"click"/, "a tool outside the scope never reaches the helper");
	await client.close();
});

test("computer.act adds acting, and a verb the helper has but this list doesn't name never appears", async () => {
	const client = await connect(withHelper, token("acts", "computer.act"));
	const tools = await computerTools(client);
	assert.deepEqual(tools, ["computer_click", "computer_open", "computer_run_steps", "computer_snapshot", "computer_status", "computer_windows"], "acting needs refs, so it reads too");
	assert.ok(!tools.includes("computer_lend"), "lending is the person's alone");
	assert.ok(!tools.includes("computer_brand_new_verb"));
	const open = (await client.listTools()).tools.find((t) => t.name === "computer_open");
	assert.deepEqual(open.inputSchema.required, ["app"]);
	assert.equal(open.annotations.readOnlyHint, false);
	await client.close();
});

test("the instructions name the limits to a session that has the tools, and not to one that doesn't", async () => {
	const has = await connect(withHelper, token("told", "computer.read"));
	assert.match(has.getInstructions(), /untrusted data/);
	assert.match(has.getInstructions(), /you can't lend/);
	await has.close();
	const hasnt = await connect(withHelper, token("not-told", "browser.read"));
	assert.doesNotMatch(hasnt.getInstructions(), /computer_/);
	await hasnt.close();
});

test("a helper older than the connector flag is never used: its calls wouldn't be capped", async () => {
	rmSync(log, { force: true });
	for (const name of ["local-studio-computer", "another-connector"]) {
		const old = join(bin, `old-${name}`);
		writeFileSync(old, `#!/bin/sh\nFAKE_SERVER_NAME=${name} exec ${JSON.stringify(helper)} "$@"\n`);
		chmodSync(old, 0o755);
		const url = await serve({ LOCAL_STUDIO_COMPUTER_BIN: old });
		const client = await connect(url, token(`old-helper-${name}`, "computer.act"));
		assert.deepEqual(await computerTools(client), ["computer_status"], name);
		assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /isn't available/);
		await client.close();
	}
});

test("a helper that stops turns into an error on that call and the next, not a hang", async () => {
	const client = await connect(withHelper, token("stops", "computer.act"));
	const answer = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(answer.isError, true);
	assert.match(answer.content[0].text, /stopped/);
	const next = await client.callTool({ name: "computer_windows", arguments: {} });
	assert.equal(next.isError, true);
	assert.match(next.content[0].text, /stopped/);
	await client.close();
});

test("with no helper on this machine the scope grants nothing and the session still works", async () => {
	const url = await serve({ LOCAL_STUDIO_COMPUTER_BIN: join(root, "nope") });
	const client = await connect(url, token("nothing", "computer.act,browser.read"));
	assert.deepEqual(await computerTools(client), ["computer_status"], "the session can say why");
	assert.ok((await client.listTools()).tools.some((t) => t.name === "read_page"));
	assert.doesNotMatch(client.getInstructions(), /computer_open/);
	await client.close();
});

async function consent(extra) {
	const url = await serve(extra, ["--public-url", "https://example.test"]);
	const origin = new URL(url).origin;
	const headers = { Host: "example.test", "x-forwarded-proto": "https" };
	const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`, { headers })).json();
	return meta.scopes_supported;
}

test("the approval page offers computer use only where the helper is, and never ticks it", async () => {
	assert.ok((await consent({ LOCAL_STUDIO_COMPUTER_BIN: helper })).includes("computer.act"));
	assert.ok(!(await consent({ LOCAL_STUDIO_COMPUTER_BIN: join(root, "nope") })).includes("computer.act"));
	const page = readFileSync(join(here, "..", "src", "oauth.ts"), "utf8");
	const grant = /export const DEFAULT_GRANT = \[(.*?)\]/.exec(page)[1];
	assert.ok(!grant.includes("computer"), "off until a person ticks it");
});

// The local stdio server (`local-studio-browser mcp`) runs as the user, so it runs the helper without --connector and offers
// every tool the helper lists, as the helper describes it. A missing, hung or slow helper never holds up the browser tools.
const localLog = join(root, "local-helper.log");
const localHelper = join(bin, "fake-spaces-local");
const PNG = Buffer.from("fake png bytes").toString("base64");
const REFUSAL = JSON.stringify({ ok: false, error: { code: "outside_agent_workspace", message: "window 7 is not on the agent workspace", suggestion: "Ask the user to lend it.", retry: "never" } });
writeFileSync(
	localHelper,
	`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = (entry) => appendFileSync(${JSON.stringify(localLog)}, JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2) });
const tool = (name, readOnly, properties = {}, required = []) => ({
	name,
	description: "The helper's own words for " + name + ".",
	inputSchema: { type: "object", properties, required, additionalProperties: false },
	annotations: { readOnlyHint: readOnly, openWorldHint: false },
});
const tools = [
	tool("windows", true),
	tool("snapshot", true, { app: { type: "string", description: "App name" }, interactive: { type: "boolean", description: "Refs only" } }),
	tool("click", false, { ref: { type: "string", description: "A ref" } }, ["ref"]),
	tool("shot", false, { window: { type: "integer", description: "Window id" } }, ["window"]),
	tool("open", false, { app: { type: "string", description: "App" }, targets: { type: "array", items: { type: "string" }, description: "Files" } }, ["app"]),
	tool("run_steps", false, { steps: { type: "array", items: { type: "object" }, description: "Steps" } }, ["steps"]),
	tool("lend", false, { app: { type: "string", description: "App" } }),
	tool("brand_new_verb", true),
];
const delay = Number(process.env.FAKE_LIST_DELAY_MS ?? 0);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
	if (m.method === "initialize") return reply({ serverInfo: { name: "local-studio-computer" } });
	if (m.method === "hands/grants") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found: hands/grants" } }) + "\\n");
	if (m.method === "tools/list") {
		if (process.env.FAKE_HANG === "1") return;
		return setTimeout(() => reply({ tools }), delay);
	}
	log(m.params);
	if (m.params.name === "shot") return reply({ content: [{ type: "text", text: '{"ok":true,"data":{"path":"/tmp/x.png"}}' }, { type: "image", data: ${JSON.stringify(PNG)}, mimeType: "image/png" }], isError: false });
	if (m.params.name === "click") return reply({ content: [{ type: "text", text: ${JSON.stringify(REFUSAL)} }], isError: true });
	reply({ content: [{ type: "text", text: "did " + m.params.name }], isError: false });
});
`,
);
chmodSync(localHelper, 0o755);

async function local(extra, args = []) {
	const client = new Client({ name: "computer-local-test", version: "0.0.0" });
	locals.push(client);
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", ...args], env: { ...base, ...extra }, stderr: "ignore" }));
	return client;
}

test("the local server lists computer_* tools from the helper's own list, as the helper describes them", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper });
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name).filter((n) => n.startsWith("computer_")).sort();
	assert.deepEqual(names, ["computer_brand_new_verb", "computer_click", "computer_open", "computer_run_steps", "computer_shot", "computer_snapshot", "computer_status", "computer_windows"], "every helper tool but lend");
	assert.ok(tools.some((t) => t.name === "read_page"), "browser tools are still there");
	const open = tools.find((t) => t.name === "computer_open");
	assert.equal(open.description, "The helper's own words for open.");
	assert.deepEqual(open.inputSchema.required, ["app"]);
	assert.equal(open.inputSchema.properties.targets.type, "array");
	assert.equal(tools.find((t) => t.name === "computer_windows").annotations.readOnlyHint, true);
	assert.equal(tools.find((t) => t.name === "computer_shot").annotations.readOnlyHint, false, "read-only as the helper marks it");
	assert.match(client.getInstructions(), /computer_\* tools for native apps/);
	assert.match(client.getInstructions(), /never take focus/);
	assert.equal((await client.callTool({ name: "computer_windows", arguments: {} })).content[0].text, "did windows");
	await client.close();
});

test("the local server runs the helper without --connector", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper });
	await client.listTools();
	const first = JSON.parse(readFileSync(localLog, "utf8").trim().split("\n")[0]);
	assert.deepEqual(first.argv, ["mcp"]);
	await client.close();
});

test("a remote session still runs the helper with --connector", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("still-capped", "computer.read"));
	await client.callTool({ name: "computer_windows", arguments: {} });
	assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]).argv, ["mcp", "--connector"]);
	await client.close();
});

test("with no helper the local server keeps its browser tools, and computer_status says how to get computer use", async () => {
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: join(root, "nope") });
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((t) => t.name).filter((n) => n.startsWith("computer_")), ["computer_status"]);
	assert.ok(tools.some((t) => t.name === "read_page"));
	assert.doesNotMatch(client.getInstructions(), /computer_open/);
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.match(status, /Local Studio's computer-use helper, local-studio-computer, isn't installed here/);
	assert.match(status, process.platform === "linux" ? /build local-studio-computer from hands\/linux/ : /local-studio-computer/);
	await client.close();
});

test("a hung helper doesn't hold tools/list past its budget, and computer_status says it's starting", async () => {
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper, FAKE_HANG: "1" });
	const started = Date.now();
	const { tools } = await client.listTools();
	const took = Date.now() - started;
	assert.ok(took < 3500, `tools/list took ${took} ms`);
	assert.deepEqual(tools.map((t) => t.name).filter((n) => n.startsWith("computer_")), ["computer_status"]);
	assert.ok(tools.some((t) => t.name === "read_page"));
	assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /still starting/);
	await client.close();
});

test("a slow helper's tools arrive on a later list", async () => {
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper, FAKE_LIST_DELAY_MS: "2600" });
	const computer = async () => (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("computer_"));
	assert.deepEqual(await computer(), ["computer_status"], "past the budget, browser tools only");
	await new Promise((done) => setTimeout(done, 1500));
	assert.ok((await computer()).includes("computer_windows"));
	await client.close();
});

test("the helper's answers pass through unchanged: a shot's image and a structured error", async () => {
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper });
	await client.listTools();
	const shot = await client.callTool({ name: "computer_shot", arguments: { window: 7 } });
	assert.equal(shot.isError, false);
	assert.deepEqual(shot.content[1], { type: "image", data: PNG, mimeType: "image/png" });
	const refused = await client.callTool({ name: "computer_click", arguments: { ref: "@a:e1" } });
	assert.equal(refused.isError, true);
	assert.deepEqual(refused.content, [{ type: "text", text: REFUSAL }]);
	await client.close();
});

// 251 r1 first-F1: a list of objects is a list of objects, through the connector and the local server alike.
const STEPS = [{ tool: "click", args: { ref: "5" } }, { tool: "type", args: { ref: "7", text: "hi" } }];

test("a connector session's computer_run_steps takes its steps as objects and hands them to the helper unchanged", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("steps", "computer.act"));
	const listed = (await client.listTools()).tools.find((t) => t.name === "computer_run_steps");
	assert.equal(listed.inputSchema.properties.steps.items.type, "object");
	const answer = await client.callTool({ name: "computer_run_steps", arguments: { steps: STEPS } });
	assert.equal(answer.isError, false, JSON.stringify(answer.content));
	assert.equal(answer.content[0].text, "did run_steps");
	const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(calls.at(-1), { name: "run_steps", arguments: { steps: STEPS } });
	await client.close();
});

// 251 r2 second-second-F2: a connector's run_steps reaches only the verbs this repo names and the session may call.
test("a connector session's computer_run_steps can't reach a verb the connector's list leaves out", async () => {
	rmSync(log, { force: true });
	const client = await connect(withHelper, token("steps-cap", "computer.act"));
	for (const bad of ["brand_new_verb", "computer_lend", "move", "run_steps"]) {
		const answer = await client.callTool({ name: "computer_run_steps", arguments: { steps: [...STEPS, { tool: bad, args: {} }] } });
		assert.equal(answer.isError, true, bad);
		assert.match(answer.content[0].text, new RegExp(`step 3: ${bad} isn't a tool this session can use, so nothing ran`));
	}
	const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	assert.equal(calls.filter((c) => c.name === "run_steps").length, 0, "nothing reached the helper");
	const ok = await client.callTool({ name: "computer_run_steps", arguments: { steps: [{ tool: "computer_click", args: { ref: "5" } }, { tool: "set-value", args: { ref: "7", value: "x" } }] } });
	assert.equal(ok.isError, false, JSON.stringify(ok.content));
	await client.close();
});

test("the local server's computer_run_steps takes its steps as objects and hands them to the helper unchanged", async () => {
	rmSync(localLog, { force: true });
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: localHelper });
	await client.listTools();
	const answer = await client.callTool({ name: "computer_run_steps", arguments: { steps: STEPS } });
	assert.equal(answer.isError, false, JSON.stringify(answer.content));
	const calls = readFileSync(localLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(calls.at(-1), { name: "run_steps", arguments: { steps: STEPS } });
	const strings = await client.callTool({ name: "computer_open", arguments: { app: "TextEdit", targets: ["a.txt"] } });
	assert.equal(strings.isError, false, "a list of strings still is one");
	await client.close();
});

// Issue #27: Local Studio's own helper, and the status and doctor name it when it answers.
function namedHelper(dir, name, serverName, env = "") {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\n${env}FAKE_SERVER_NAME=${serverName} exec ${JSON.stringify(helper)} "$@"\n`);
	chmodSync(path, 0o755);
	return path;
}

test("a connector session takes a helper that answers as local-studio-connector", async () => {
	const localStudio = namedHelper(join(root, "local-studio-connector"), "local-studio-computer", "local-studio-connector");
	const url = await serve({ LOCAL_STUDIO_COMPUTER_BIN: localStudio });
	const client = await connect(url, token("local-studio-helper", "computer.read"));
	assert.deepEqual(await computerTools(client), ["computer_snapshot", "computer_status", "computer_windows"]);
	await client.close();
});

test("local-studio-computer on PATH answers, and computer_status names it", async () => {
	const dir = join(root, "on-path");
	const ours = namedHelper(dir, "local-studio-computer", "local-studio-computer");
	const client = await local({ PATH: `${dir}:${bin}:/bin:/usr/bin` });
	await client.listTools();
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.match(status, /Computer use is available/);
	assert.ok(status.includes(`local-studio-computer (${ours})`), status);
	assert.match(status, /answered as local-studio-computer/);
	await client.close();
});

test("computer_status passes on the helper's missing Accessibility grant: what to allow and where", async () => {
	const ours = namedHelper(join(root, "no-grant"), "local-studio-computer", "local-studio-computer", "FAKE_GRANTS=missing ");
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: ours });
	await client.listTools();
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.match(status, /installed but the OS hasn't allowed all of it yet/);
	assert.ok(status.includes("System Settings > Privacy & Security > Accessibility and turn on Terminal (/System/Applications/Utilities/Terminal.app)"), status);
	assert.doesNotMatch(status, /Computer use is available/);
	await client.close();
});

test("a connector session's computer_status says what to allow too", async () => {
	const ours = namedHelper(join(root, "no-grant-connector"), "local-studio-computer", "local-studio-connector", "FAKE_GRANTS=missing ");
	const url = await serve({ LOCAL_STUDIO_COMPUTER_BIN: ours });
	const client = await connect(url, token("no-grant", "computer.read"));
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.match(status, /the OS hasn't allowed all of it yet/);
	assert.match(status, /Privacy & Security > Accessibility/);
	await client.close();
});

test("a helper that stops or never answers hands/grants isn't available, here or on a connector", async () => {
	for (const how of ["hang", "exit"]) {
		const ours = namedHelper(join(root, `grants-${how}`), "local-studio-computer", "local-studio-connector", `FAKE_GRANTS=${how} `);
		const client = await connect(await serve({ LOCAL_STUDIO_COMPUTER_BIN: ours }), token(`grants-${how}`, "computer.read"));
		assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /isn't on this computer or isn't answering/, how);
		await client.close();
		const mine = namedHelper(join(root, `grants-local-${how}`), "local-studio-computer", "local-studio-computer", `FAKE_GRANTS=${how} `);
		const here = await local({ LOCAL_STUDIO_COMPUTER_BIN: mine });
		await here.listTools();
		assert.match((await here.callTool({ name: "computer_status", arguments: {} })).content[0].text, how === "hang" ? /helper isn't answering/ : /helper stopped/);
		await here.close();
	}
});

test("a missing grant with only a message is still reported", async () => {
	const ours = namedHelper(join(root, "grants-bare"), "local-studio-computer", "local-studio-computer", "FAKE_GRANTS=bare ");
	const client = await local({ LOCAL_STUDIO_COMPUTER_BIN: ours });
	await client.listTools();
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.match(status, /yet\. screen capture is off\. Browser tools/);
	assert.doesNotMatch(status, /Computer use is available/);
	await client.close();
});

test("a helper with no hands/grants (an older one) still reads as available", async () => {
	const client = await connect(withHelper, token("old-grants", "computer.read"));
	assert.match((await client.callTool({ name: "computer_status", arguments: {} })).content[0].text, /Computer use is available/);
	await client.close();
});

function doctorComputer(extra) {
	const r = spawnSync(process.execPath, [cli, "doctor", "--json"], { env: { ...base, ...extra }, encoding: "utf8", timeout: 30_000 });
	return JSON.parse(r.stdout).checks.find((c) => c.id === "computer");
}

test("doctor names the helper that answered, or says there is none", () => {
	const ours = namedHelper(join(root, "doctor"), "local-studio-computer", "local-studio-computer");
	const found = doctorComputer({ LOCAL_STUDIO_COMPUTER_BIN: ours });
	assert.equal(found.status, "ok");
	assert.ok(found.label.includes(`local-studio-computer (${ours}), answered as local-studio-computer`), found.label);
	const none = doctorComputer({ LOCAL_STUDIO_COMPUTER_BIN: join(root, "nope") });
	assert.equal(none.status, "warn", "none is news, not a failure");
	assert.match(none.label, /no helper installed/);
	const silent = join(root, "doctor", "silent");
	writeFileSync(silent, "#!/bin/sh\nexec sleep 30\n");
	chmodSync(silent, 0o755);
	const hung = doctorComputer({ LOCAL_STUDIO_COMPUTER_BIN: silent });
	assert.equal(hung.status, "warn");
	assert.match(hung.label, /didn't answer/);
});

test("a connector's helper gets the way to the desktop and the settings folder, and nothing else of the service's", async () => {
	rmSync(log, { force: true });
	const url = await serve({ LOCAL_STUDIO_COMPUTER_BIN: helper, DISPLAY: ":3", WAYLAND_DISPLAY: "wayland-9", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus", FAKE_LEAK: "service only" });
	const client = await connect(url, token("desktop-env", "computer.read"));
	await client.callTool({ name: "computer_windows", arguments: {} });
	const first = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
	assert.deepEqual(first.argv, ["mcp", "--connector"]);
	assert.deepEqual(first.env, { DISPLAY: ":3", WAYLAND_DISPLAY: "wayland-9", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus", LOCAL_STUDIO_BROWSER_DIR: base.LOCAL_STUDIO_BROWSER_DIR });
	await client.close();
});

// ---- one group alone (`mcp --tools`), as the Local Studio app starts it ----

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name);

test("mcp --tools offers only the named group, and both is the whole list", async () => {
	const ours = { LOCAL_STUDIO_COMPUTER_BIN: localHelper };
	const all = await toolNames(await local(ours));
	const browser = await local(ours, ["--tools", "browser"]);
	assert.deepEqual(await toolNames(browser), all.filter((n) => !n.startsWith("computer_")));
	assert.doesNotMatch(browser.getInstructions(), /computer_/);
	const computer = await local(ours, ["--tools=computer"]);
	assert.deepEqual(await toolNames(computer), all.filter((n) => n.startsWith("computer_")));
	assert.doesNotMatch(computer.getInstructions(), /browser|read_page/i);
	assert.deepEqual(await toolNames(await local(ours, ["--tools", "browser, computer"])), all);
	assert.ok((await toolNames(await local(ours, ["--tools", "computer", "--profile", "small"]))).every((n) => n.startsWith("computer_") || n === "more_tools"));
});

test("mcp --tools computer registers no browser, and its status doesn't speak of one", async () => {
	const home = join(root, "computer-only");
	mkdirSync(join(home, ".config", "google-chrome"), { recursive: true });
	mkdirSync(join(home, "Library", "Application Support", "Google", "Chrome"), { recursive: true });
	const own = { HOME: home, LOCAL_STUDIO_BROWSER_DIR: join(home, "config"), LOCAL_STUDIO_COMPUTER_BIN: "/nope" };
	const client = await local(own, ["--tools", "computer"]);
	const status = (await client.callTool({ name: "computer_status", arguments: {} })).content[0].text;
	assert.doesNotMatch(status, /Browser tools/);
	assert.equal(existsSync(join(home, ".config", "google-chrome", "NativeMessagingHosts")), false);
	assert.equal(existsSync(join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")), false);
	assert.equal(existsSync(join(home, "config")), false, "nothing written");
});

test("mcp --tools refuses a name it doesn't know, an empty value and the panel profile", () => {
	for (const args of [["--tools", "brwser"], ["--tools", "browser,"], ["--tools="], ["--tools"], ["--profile", "panel", "--tools", "browser"]]) {
		const r = spawnSync(process.execPath, [cli, "mcp", ...args], { env: base, encoding: "utf8", input: "", timeout: 30_000 });
		assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
	}
});

test("status --json says what the OS allows the helper, and answers in time when the helper doesn't", () => {
	const report = (extra) => JSON.parse(spawnSync(process.execPath, [cli, "status", "--json"], { env: { ...base, ...extra }, encoding: "utf8", timeout: 30_000 }).stdout).computer;
	const rows = namedHelper(join(root, "rows"), "local-studio-computer", "local-studio-computer", "FAKE_GRANTS=rows ");
	assert.deepEqual(report({ LOCAL_STUDIO_COMPUTER_BIN: rows }), { helper: rows, answered: true, grants: [{ name: "Accessibility", ok: true, text: "on" }, { name: "Screen Recording", ok: false, text: "" }] });
	const old = namedHelper(join(root, "rows-old"), "local-studio-computer", "local-studio-computer");
	assert.deepEqual(report({ LOCAL_STUDIO_COMPUTER_BIN: old }), { helper: old, answered: true, grants: [] });
	assert.deepEqual(report({ LOCAL_STUDIO_COMPUTER_BIN: "/nope" }), { helper: null, answered: false, grants: [] });
	const hung = namedHelper(join(root, "rows-hang"), "local-studio-computer", "local-studio-computer", "FAKE_GRANTS=hang ");
	const started = Date.now();
	assert.deepEqual(report({ LOCAL_STUDIO_COMPUTER_BIN: hung }), { helper: hung, answered: false, grants: [] });
	assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
});
