// The relay route (cli/src/relay.ts): remote.json's relay block, and the connector end to end. The relay is a local stand-in
// (helpers/relay-stand-in.mjs); nothing here reaches Cloudflare or touches the real config folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { freePort, standIn, until } from "./helpers/relay-stand-in.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "local-studio-browser-relay-"));
// A connector a test just stopped can still be writing its state file, so the removal retries.
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const mod = await loadTs(`
export { generateRelayKey, relayRoutes, readRelayStatus, runRelay, HEALTH_PATH, RELAY_SERVICE } from "@src/relay.ts";
export { loadRemoteConfig, saveRemoteConfig, remoteFile } from "@src/remote-config.ts";
export { LOCAL_STUDIO_BROWSER_PATHS } from "@src/route-record.ts";
export { OWNED_SERVICES } from "@src/service-version.ts";
`);

const noWebSocket = typeof WebSocket !== "function" && "the relay client needs Node's built-in WebSocket (Node 22)";
const KEY = "k".repeat(43);

test("a relay key is 32 random bytes in base64url without padding", () => {
	const keys = new Set(Array.from({ length: 20 }, () => mod.generateRelayKey()));
	assert.equal(keys.size, 20);
	for (const key of keys) {
		assert.match(key, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(Buffer.from(key, "base64url").length, 32);
	}
});

test("the client forwards serve's nine paths and its health check to serve on loopback, and nothing else", () => {
	const routes = mod.relayRoutes(18787);
	assert.deepEqual(Object.keys(routes).sort(), [...mod.LOCAL_STUDIO_BROWSER_PATHS, "/v1/health"].sort());
	for (const origin of Object.values(routes)) assert.equal(origin, "http://127.0.0.1:18787");
	assert.equal(mod.HEALTH_PATH, "/v1/health");
});

test("the relay service runs `remote relay run` and restarts with the others", () => {
	assert.deepEqual(mod.RELAY_SERVICE.args, ["remote", "relay", "run"]);
	assert.equal(mod.RELAY_SERVICE.label, "com.localstudio.browser.relay");
	assert.equal(mod.RELAY_SERVICE.unit, "local-studio-browser-relay.service");
	assert.ok(mod.OWNED_SERVICES.includes(mod.RELAY_SERVICE));
});

test("remote.json keeps the relay block 0600 and refuses a bad one without printing the key", (t) => {
	const dir = join(root, "config");
	mkdirSync(dir, { mode: 0o700 });
	process.env.LOCAL_STUDIO_BROWSER_DIR = dir;
	t.after(() => delete process.env.LOCAL_STUDIO_BROWSER_DIR);
	const good = { publicUrl: "https://local-studio-browser-relay.someone.workers.dev", port: 18787, route: "relay", relay: { name: "local-studio-browser-relay", key: KEY } };
	mod.saveRemoteConfig(good);
	if (process.platform !== "win32") assert.equal(statSync(mod.remoteFile()).mode & 0o777, 0o600);
	assert.deepEqual(mod.loadRemoteConfig(), good);
	const withAccount = { ...good, relay: { ...good.relay, accountId: "0123456789abcdef0123456789abcdef" } };
	mod.saveRemoteConfig(withAccount);
	assert.deepEqual(mod.loadRemoteConfig(), withAccount);
	const file = join(dir, "bad.json");
	const refused = (raw, pattern) => {
		writeFileSync(file, JSON.stringify(raw));
		assert.throws(
			() => mod.loadRemoteConfig(file),
			(err) => pattern.test(err.message) && !err.message.includes(String(raw.relay?.key ?? KEY)),
		);
	};
	const { relay, ...bare } = good;
	refused(bare, /relay route needs its relay block/);
	refused({ ...good, relay: "x" }, /relay must be an object/);
	refused({ ...good, relay: { ...relay, name: "-bad" } }, /relay\.name must be a Worker name/);
	refused({ ...good, relay: { ...relay, name: "Upper" } }, /relay\.name/);
	refused({ ...good, relay: { ...relay, key: "short-key-value" } }, /relay\.key isn't a relay key/);
	refused({ ...good, relay: { ...relay, key: `${"a".repeat(42)}=` } }, /relay\.key/);
	refused({ ...good, relay: { ...relay, accountId: "nope" } }, /relay\.accountId/);
	refused({ ...good, route: "other" }, /route must be funnel, custom, cloudflare, tailnet or relay/);
});

test("the connector's state reads stopped once the process that wrote it is gone, and nothing for a damaged file", () => {
	const file = join(root, "state.json");
	assert.equal(mod.readRelayStatus(file), undefined);
	writeFileSync(file, JSON.stringify({ state: "connected", at: 1, pid: process.pid }));
	assert.equal(mod.readRelayStatus(file).state, "connected");
	writeFileSync(file, JSON.stringify({ state: "connected", at: 1, pid: 2 ** 31 - 2 }));
	assert.equal(mod.readRelayStatus(file).state, "stopped");
	writeFileSync(file, JSON.stringify({ state: "dancing", at: 1, pid: process.pid }));
	assert.equal(mod.readRelayStatus(file), undefined);
	writeFileSync(file, "{");
	assert.equal(mod.readRelayStatus(file), undefined);
});

test("runRelay refuses a remote.json that isn't on the relay route", async () => {
	const lines = [];
	const code = await mod.runRelay({ config: { publicUrl: "https://x.example.com", port: 1, route: "cloudflare" }, log: (l) => lines.push(l), until: Promise.resolve() });
	assert.equal(code, 1);
	assert.match(lines.join("\n"), /isn't on the relay route/);
});

/** `local-studio-browser <args>` with this config folder, stopped when the test ends. */
function start(t, dir, args) {
	const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, LOCAL_STUDIO_BROWSER_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (b) => (out += b));
	child.stderr.on("data", (b) => (out += b));
	t.after(() => child.kill("SIGTERM"));
	return { child, out: () => out };
}

test("end to end: a request through the relay reaches serve and comes back, from the processes the services run", { skip: noWebSocket }, async (t) => {
	const relay = await standIn(KEY);
	t.after(relay.close);
	const dir = join(root, "e2e");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const port = await freePort();
	writeFileSync(join(dir, "remote.json"), JSON.stringify({ publicUrl: relay.url, port, route: "relay", relay: { name: "local-studio-browser-relay", key: KEY } }), { mode: 0o600 });
	const serve = start(t, dir, ["serve"]);
	const connector = start(t, dir, ["remote", "relay", "run"]);
	const state = () => {
		try {
			return JSON.parse(readFileSync(join(dir, "relay-state.json"), "utf8")).state;
		} catch {
			return undefined;
		}
	};
	await until(() => state() === "connected", `connected (${connector.out()})`);
	if (process.platform !== "win32") assert.equal(statSync(join(dir, "relay-state.json")).mode & 0o777, 0o600);
	assert.deepEqual(await (await fetch(`${relay.url}/_relay/health`)).json(), { ok: true, connected: true });

	// serve answers through the relay once it listens.
	await until(async () => (await fetch(`${relay.url}/v1/health`)).status === 200, `serve through the relay (${serve.out()})`);
	const health = await fetch(`${relay.url}/v1/health`);
	assert.equal(health.headers.get("content-type"), "application/json");
	assert.deepEqual(await health.json(), { ok: true });

	// OAuth metadata for the public address: the Host the relay set reached serve unchanged.
	const meta = await (await fetch(`${relay.url}/.well-known/oauth-protected-resource/mcp`)).json();
	assert.equal(meta.resource, `${relay.url}/mcp`);

	// A request with a body, and serve's refusal and its challenge header, come back whole.
	const mcp = await fetch(`${relay.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
	assert.equal(mcp.status, 401);
	assert.match(mcp.headers.get("www-authenticate"), /resource_metadata=/);

	// A path outside the list never reaches serve: the client answers it.
	const other = await fetch(`${relay.url}/link`);
	assert.equal(other.status, 404);
	assert.match(await other.text(), /No local route/);

	// SIGTERM stops the connector and the relay sees it go.
	connector.child.kill("SIGTERM");
	await until(() => relay.conn === null && state() === "stopped", "stopped");
	assert.ok(!connector.out().includes(KEY), "the key never reaches the log");
});

test("a wrong key reads unauthorized, and the connector stays up instead of retrying", { skip: noWebSocket }, async (t) => {
	const relay = await standIn(KEY);
	t.after(relay.close);
	const dir = join(root, "wrong-key");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const port = await freePort();
	writeFileSync(join(dir, "remote.json"), JSON.stringify({ publicUrl: relay.url, port, route: "relay", relay: { name: "local-studio-browser-relay", key: "w".repeat(43) } }), { mode: 0o600 });
	const connector = start(t, dir, ["remote", "relay", "run"]);
	const file = join(dir, "relay-state.json");
	await until(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).state === "unauthorized", `unauthorized (${connector.out()})`);
	await until(() => /refused the key/.test(connector.out()), `the log line (${connector.out()})`);
	// The first retry after a drop waits about a second, so one that retried would have by now.
	await new Promise((r) => setTimeout(r, 2_500));
	assert.equal(connector.child.exitCode, null, "still running");
	assert.equal(connector.out().match(/refused the key|Connecting to the relay/g).length, 2, `one try (${connector.out()})`);
	assert.equal(relay.connects, 0);
	assert.equal(mod.readRelayStatus(file).state, "unauthorized");
});

test("a state file that can't be written never stops the connector", { skip: noWebSocket }, async (t) => {
	const relay = await standIn(KEY);
	t.after(relay.close);
	const dir = join(root, "unwritable");
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(dir, "file"), "");
	const config = { publicUrl: relay.url, port: await freePort(), route: "relay", relay: { name: "local-studio-browser-relay", key: KEY } };
	const lines = [];
	let stop;
	const ran = mod.runRelay({ config, stateFile: join(dir, "file", "relay-state.json"), log: (l) => lines.push(l), until: new Promise((r) => (stop = r)) });
	t.after(() => stop());
	await until(() => relay.conn !== null, `connected (${lines.join("\n")})`);
	await until(() => lines.some((l) => l.startsWith("Connected")), lines.join("\n"));
	assert.ok(lines.some((l) => /^Couldn't save the state in /.test(l)), lines.join("\n"));
	stop();
	assert.equal(await ran, 0);
});
