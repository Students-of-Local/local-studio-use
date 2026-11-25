// The relay's two vendored pieces from baney75/local-studio-tunnels: the connector (cli/src/relay-client.ts) and the Worker it dials
// (cli/src/relay-dist.ts, written by scripts/vendor-relay.mjs). Each stays upstream's bytes, and the connector carries a request from
// a local stand-in relay to a local server and back. Nothing here reaches Cloudflare.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { standIn, until } from "./helpers/relay-stand-in.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await loadTs(`
export { RelayClient } from "@src/relay-client.ts";
export { RELAY_COMMIT, RELAY_JS, RELAY_WRANGLER } from "@src/relay-dist.ts";
`);

const noWebSocket = typeof WebSocket !== "function" && "the relay client needs Node's built-in WebSocket (Node 22)";
const COMMIT = "741ff1611f280b23e7fbad0862f0e71201a8f9c7";
const KEY = "k".repeat(43);
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("the vendored client is the upstream file, unchanged below its header", () => {
	const text = readFileSync(join(here, "..", "src", "relay-client.ts"), "utf8");
	const marker = "// ---- upstream file starts here ----\n";
	assert.ok(text.includes(marker));
	assert.ok(text.includes(`commit ${COMMIT}`));
	assert.equal(sha(text.slice(text.indexOf(marker) + marker.length)), "78efcabdd8ccec6d20571042d515c2f3cfa0fd655e5ac50eb1dccd8bc8f1c672");
});

test("the vendored relay bundle and its config are upstream's files at the named commit", () => {
	assert.equal(mod.RELAY_COMMIT, COMMIT);
	assert.equal(sha(mod.RELAY_JS), "3bb1f173b4100933e40c87efba8632d3236954b85e6693b56cc01d7daae87ade");
	assert.equal(sha(mod.RELAY_WRANGLER), "c020a9b02ec0d5a271dfef8de77b631496eab63864cb7958bae29c56394f9b71");
});

/** A connector with `key` and one route, its states in order. */
function connect(t, url, key, routes) {
	const states = [];
	const client = new mod.RelayClient({ url, key, routes, onState: (s) => states.push(s) });
	client.start();
	t.after(() => client.stop());
	return { client, states };
}

test("the client carries a request with its body and Host to the routed server and the answer back, and answers other paths itself", { skip: noWebSocket }, async (t) => {
	const seen = [];
	const origin = createServer((req, res) => {
		let body = "";
		req.on("data", (b) => (body += b));
		req.on("end", () => {
			seen.push({ method: req.method, url: req.url, host: req.headers.host, body });
			res.writeHead(201, { "content-type": "text/plain", "x-origin": "yes" }).end(`got ${body}`);
		});
	});
	await new Promise((r) => origin.listen(0, "127.0.0.1", r));
	t.after(() => origin.close());
	const relay = await standIn(KEY);
	t.after(relay.close);
	const { client, states } = connect(t, relay.url, KEY, { "/mcp": `http://127.0.0.1:${origin.address().port}` });
	await until(() => client.state === "connected", "connected");
	const res = await fetch(`${relay.url}/mcp?a=1`, { method: "POST", body: "hello" });
	assert.equal(res.status, 201);
	assert.equal(res.headers.get("x-origin"), "yes");
	assert.equal(await res.text(), "got hello");
	assert.deepEqual(seen, [{ method: "POST", url: "/mcp?a=1", host: `127.0.0.1:${relay.port}`, body: "hello" }]);
	const other = await fetch(`${relay.url}/admin`);
	assert.equal(other.status, 404);
	assert.match(await other.text(), /No local route/);
	assert.equal(seen.length, 1, "an unrouted path never reaches the server");
	client.stop();
	await until(() => relay.conn === null, "the relay to see it go");
	assert.deepEqual(states, ["connecting", "connected", "stopped"]);
});

test("a body reaches the server inside its own request whatever the method, and an empty one adds no framing", { skip: noWebSocket }, async (t) => {
	const seen = [];
	const origin = createServer((req, res) => {
		let body = "";
		req.on("data", (b) => (body += b));
		req.on("end", () => {
			seen.push({ method: req.method, body, framing: req.headers["transfer-encoding"] ?? req.headers["content-length"] });
			res.end("ok");
		});
	});
	await new Promise((r) => origin.listen(0, "127.0.0.1", r));
	t.after(() => origin.close());
	const relay = await standIn(KEY);
	t.after(relay.close);
	const { client } = connect(t, relay.url, KEY, { "/mcp": `http://127.0.0.1:${origin.address().port}` });
	await until(() => client.state === "connected", "connected");
	for (const method of ["DELETE", "OPTIONS", "POST"]) {
		const res = await fetch(`${relay.url}/mcp`, { method, body: "hello" });
		assert.equal(res.status, 200, method);
		await res.text();
	}
	await (await fetch(`${relay.url}/mcp`, { method: "POST" })).text();
	assert.deepEqual(seen, [
		{ method: "DELETE", body: "hello", framing: "chunked" },
		{ method: "OPTIONS", body: "hello", framing: "chunked" },
		{ method: "POST", body: "hello", framing: "chunked" },
		{ method: "POST", body: "", framing: undefined },
	]);
});

test("a wrong key ends in unauthorized, with no retry", { skip: noWebSocket }, async (t) => {
	const relay = await standIn(KEY);
	t.after(relay.close);
	const { client, states } = connect(t, relay.url, "w".repeat(43), {});
	await until(() => client.state === "unauthorized", "unauthorized");
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(states, ["connecting", "unauthorized"]);
	assert.equal(relay.connects, 0);
});
