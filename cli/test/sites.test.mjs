// Site changes kept on this computer: what the native host writes for each browser, what it hands a new one, and
// `local-studio-browser sites`, which reads the file when no browser is open and never turns a change on.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "sites-"));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.LOCAL_STUDIO_BROWSER_DIR = join(home, "config");
const { saveSites, savedSites, sitesFile } = await loadTs(`export * from "@src/sites.ts";`);
const edit = (id, over = {}) => ({ id, host: "x.com", kind: "hide", value: ".ad", note: "Ads", on: true, addedBy: "agent:Claude", createdAt: 1, ...over });
const env = { HOME: home, PATH: dirname(process.execPath), LOCAL_STUDIO_BROWSER_DIR: join(home, "config"), LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(home, "s"), NO_COLOR: "1" };
const run = (...args) => spawnSync(process.execPath, [cli, "sites", ...args], { env, encoding: "utf8", timeout: 20_000 });

test("each browser's list is kept in a private file, checked field by field; a new browser gets the newest one with a change", () => {
	assert.equal(savedSites(), undefined);
	saveSites({ edits: [edit("a"), { ...edit("b"), extra: "x" }, edit("c", { kind: "root" }), edit("d", { on: "yes" }), edit("e", { value: "x".repeat(200_000) }), null], adBlock: true }, "b1", "Helium", 100);
	saveSites({ edits: [], adBlock: false }, "b2", "Chrome", 200);
	if (process.platform !== "win32") assert.equal(statSync(sitesFile()).mode & 0o777, 0o600);
	const file = JSON.parse(readFileSync(sitesFile(), "utf8"));
	assert.deepEqual(Object.keys(file.browsers).sort(), ["b1", "b2"]);
	assert.deepEqual(file.browsers.b1.edits, [edit("a"), edit("b")]);
	const saved = savedSites();
	assert.equal(saved.localStudioSites, 1);
	assert.deepEqual(saved.edits.map((e) => e.id), ["a", "b"]);
	assert.equal(saved.adBlock, true);
	for (let i = 0; i < 12; i++) saveSites({ edits: [edit(`n${i}`)], adBlock: false }, `old-${i}`, undefined, i);
	assert.equal(Object.keys(JSON.parse(readFileSync(sitesFile(), "utf8")).browsers).length, 8, "old browsers go");
	for (const id of ["__proto__", "../x", "", undefined]) saveSites({ edits: [edit("z")], adBlock: false }, id, undefined, 1);
	assert.deepEqual(savedSites().edits.map((e) => e.id), ["a", "b"]);
});

test("the list reads the saved copy with no browser open, and nothing is changed without one", () => {
	const list = run();
	assert.equal(list.status, 0, list.stderr);
	assert.match(list.stdout, /x\.com\n.* a {2}hide {3}Ads/);
	assert.match(list.stdout, /Saved copy/);
	const json = JSON.parse(run("list", "--json").stdout);
	assert.equal(json.saved, true);
	assert.deepEqual(json.edits.map((e) => e.id), ["a", "b"]);
	for (const sub of ["off", "remove"]) {
		const r = run(sub, "a");
		assert.equal(r.status, 1, sub);
		assert.match(r.stderr, /No browser is connected, so nothing was changed/);
	}
	for (const bad of [["on", "a"], ["off"], ["list", "x"], ["enable", "a"]]) assert.equal(run(...bad).status, 2, bad.join(" "));
	assert.deepEqual(savedSites().edits.map((e) => e.id), ["a", "b"]);
});

test("a file that isn't one holds nothing, and stays as it is until the next change", () => {
	const good = readFileSync(sitesFile(), "utf8");
	writeFileSync(sitesFile(), "{not json");
	assert.equal(savedSites(), undefined);
	assert.equal(readFileSync(sitesFile(), "utf8"), "{not json");
	assert.match(run().stdout, /No site changes yet/);
	writeFileSync(sitesFile(), JSON.stringify({ version: 2, browsers: { a: 1 } }));
	assert.equal(savedSites(), undefined);
	writeFileSync(sitesFile(), good);
});

test("the native host hands the saved list to the extension as it connects, and writes what it sends", { skip: process.platform === "win32" && "sockets", timeout: 20_000 }, async (t) => {
	const host = spawn(process.execPath, [cli, "host", `chrome-extension://${extensionId.id}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => host.kill("SIGKILL"));
	const frames = [];
	let buffer = Buffer.alloc(0);
	host.stdout.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
			frames.push(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
			buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
		}
	});
	const send = (message) => {
		const body = Buffer.from(JSON.stringify(message));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		host.stdin.write(Buffer.concat([head, body]));
	};
	const until = async (fn, what) => {
		const end = Date.now() + 10_000;
		for (;;) {
			const v = fn();
			if (v) return v;
			assert.ok(Date.now() < end, `timed out waiting for ${what}`);
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	await until(() => existsSync(env.LOCAL_STUDIO_BROWSER_SOCKET_DIR) && readdirSync(env.LOCAL_STUDIO_BROWSER_SOCKET_DIR).length, "the host's socket");
	send({ type: "hello", version: "0", protocol: 1, methods: ["edits.list"], features: ["chunks"], browserId: "live-1" });
	const saved = await until(() => frames.find((f) => f.type === "sites_saved"), "sites_saved");
	assert.deepEqual(saved.saved.edits.map((e) => e.id), ["a", "b"]);
	assert.ok(Array.isArray(saved.guardedHosts));
	send({ type: "sites", edits: [edit("live")], adBlock: false });
	await until(() => JSON.parse(readFileSync(sitesFile(), "utf8")).browsers["live-1"], "the saved list");
	assert.deepEqual(JSON.parse(readFileSync(sitesFile(), "utf8")).browsers["live-1"].edits, [edit("live")]);
	const exited = new Promise((r) => host.once("exit", r));
	host.stdin.end();
	assert.equal(await exited, 0);
});
