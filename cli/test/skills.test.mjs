// skill_search and skill_read pass through to Local Studio's command line tool; a script stands in for it here.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadTs } from "./helpers/bundle-ts.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const FAKE = `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const dir = ${"process.env.LOCAL_STUDIO_DATA_DIR"};
appendFileSync(dir + "/starts", process.pid + " " + process.argv.slice(2).join(" ") + " " + Object.keys(process.env).filter((n) => n.startsWith("SECRET")).join() + "\\n");
const say = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (method === "initialize") say(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
	if (method !== "tools/call" || existsSync(dir + "/hang")) return;
	say(id, { content: [{ type: "text", text: params.name + " " + JSON.stringify(params.arguments) }] });
});
`;
let root;
let data;
const open = [];

before(() => {
	root = mkdtempSync(join(tmpdir(), "ls-skills-"));
	data = join(root, "data");
	for (const dir of ["home", "data", "bin"]) mkdirSync(join(root, dir));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	writeFileSync(join(root, "bin", "local-studio-cli"), FAKE);
	chmodSync(join(root, "bin", "local-studio-cli"), 0o755);
	writeFileSync(join(root, "bin", "package.json"), '{"type":"module"}');
});

after(async () => {
	for (const client of open) await client.close();
	rmSync(root, { recursive: true, force: true });
});

async function start(more = {}) {
	rmSync(join(data, "starts"), { force: true });
	const client = new Client({ name: "skills-test", version: "0" });
	const env = {
		PATH: join(root, "bin"),
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "home", ".config"),
		LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(root, "sock"),
		LOCAL_STUDIO_DATA_DIR: data,
		SECRET_TOKEN: "x",
		...more,
	};
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "ignore" }));
	open.push(client);
	return client;
}

const starts = () => (existsSync(join(data, "starts")) ? readFileSync(join(data, "starts"), "utf8").trim().split("\n") : []);
const call = async (client, name, args) => {
	const result = await client.callTool({ name, arguments: args });
	return { text: result.content[0].text, isError: result.isError ?? false };
};

test("both tools pass through to one local-studio, started at the first call", async () => {
	const mcp = await start();
	assert.deepEqual(starts(), []);
	const found = await call(mcp, "skill_search", { words: "unsubscribe from newsletters", for: "gmail.com" });
	assert.equal(found.text, 'skill_search {"words":"unsubscribe from newsletters","for":"gmail.com"}');
	assert.equal((await call(mcp, "skill_read", { name: "osint", part: "Sources" })).text, 'skill_read {"name":"osint","part":"Sources"}');
	assert.equal(starts().length, 1);
	assert.match(starts()[0], /^\d+ skills mcp$/, "the person's own store, and no variable the store does not read");
});

test("a killed local-studio is started again at the next call", async () => {
	const mcp = await start();
	await call(mcp, "skill_search", { words: "x" });
	process.kill(Number(starts()[0].split(" ")[0]), "SIGKILL");
	await new Promise((done) => setTimeout(done, 200));
	assert.equal((await call(mcp, "skill_search", { words: "y" })).text, 'skill_search {"words":"y"}');
	assert.equal(starts().length, 2);
});

test("one that never answers fails after 10 s and the server lives", { timeout: 30_000 }, async () => {
	const mcp = await start();
	writeFileSync(join(data, "hang"), "");
	const began = Date.now();
	assert.deepEqual(await call(mcp, "skill_search", { words: "x" }), { text: "Skills are not answering.", isError: true });
	assert.ok(Date.now() - began < 13_000);
	rmSync(join(data, "hang"));
	assert.equal((await call(mcp, "skill_search", { words: "y" })).text, 'skill_search {"words":"y"}');
});

test("without Local Studio the answer says so and is no error", async () => {
	const mcp = await start({ PATH: join(root, "home") });
	const none = { text: "Skills come with Local Studio, which isn't installed here. Work without one.", isError: false };
	assert.deepEqual(await call(mcp, "skill_search", { words: "x" }), none);
	assert.deepEqual(await call(mcp, "skill_read", { name: "x" }), none);
	assert.ok((await mcp.listTools()).tools.length > 10);
});

test("a nightly Local Studio in ~/.local/bin answers when PATH names none", { skip: process.platform === "win32" }, async () => {
	const own = join(root, "home", ".local", "bin");
	mkdirSync(own, { recursive: true });
	writeFileSync(join(own, "local-studio-nightly"), FAKE);
	chmodSync(join(own, "local-studio-nightly"), 0o755);
	writeFileSync(join(own, "package.json"), '{"type":"module"}');
	const mcp = await start({ PATH: join(root, "home") });
	assert.equal((await call(mcp, "skill_search", { words: "x" })).text, 'skill_search {"words":"x"}');
	rmSync(own, { recursive: true });
});

test("a thread in Local Studio has its own skills server, so this one offers neither tool", async () => {
	const names = async (client) => (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith("skill_"));
	const inThread = await start({ LOCAL_STUDIO_SKILLS_SERVER: "1" });
	assert.deepEqual(await names(inThread), []);
	assert.doesNotMatch(inThread.getInstructions(), /skill_/);
	assert.deepEqual(await names(await start()), ["skill_search", "skill_read"]);
});

test("a scoped session asks for the skills that come with the app, even when created without remote: true", async () => {
	const { createMcpServer } = await loadTs('export { createMcpServer } from "@src/mcp.ts";');
	const before = { ...process.env };
	Object.assign(process.env, { LOCAL_STUDIO_CLI_BIN: join(root, "bin", "local-studio-cli"), LOCAL_STUDIO_DATA_DIR: data });
	try {
		for (const options of [{ allowedTools: new Set(["skill_search", "skill_read"]) }, { remote: true }]) {
			rmSync(join(data, "starts"), { force: true });
			const { server, client: bridge } = createMcpServer({ name: "scoped", session: "scoped", ...options });
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			const client = new Client({ name: "scoped-test", version: "0" });
			await client.connect(b);
			assert.equal((await call(client, "skill_read", { name: "dorks" })).text, 'skill_read {"name":"dorks"}');
			assert.match(starts()[0], /^\d+ skills mcp --shipped$/);
			await client.close();
			bridge.close?.();
		}
	} finally {
		for (const name of ["LOCAL_STUDIO_CLI_BIN", "LOCAL_STUDIO_DATA_DIR"]) {
			if (before[name] === undefined) delete process.env[name];
			else process.env[name] = before[name];
		}
	}
});
