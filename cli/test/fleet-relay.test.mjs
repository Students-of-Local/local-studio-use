import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { FleetRelay, fleetBase, fleetKeyPath } = await loadTs(`export { FleetRelay, fleetBase, fleetKeyPath } from "@src/fleet.ts";`);

const KEY = "stub-fleet-key-4f1c9a";

async function stub(t, handle) {
	const seen = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => {
			body += d;
		});
		req.on("end", () => {
			const r = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined, closed: false };
			req.socket.on("close", () => {
				r.closed = true;
			});
			seen.push(r);
			handle(req, res, r);
		});
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return { base: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

function relay(t, base, key = KEY, config = {}) {
	const home = mkdtempSync(join(tmpdir(), "fleet-relay-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	if (key) {
		mkdirSync(join(home, ".local-studio-controller"));
		writeFileSync(join(home, ".local-studio-controller", "config.json"), JSON.stringify({ fleetKey: key, ...config }));
	}
	const frames = [];
	const waiters = new Map();
	const r = new FleetRelay(
		(frame) => {
			frames.push(frame);
			if (frame.id !== undefined) waiters.get(`${frame.conversation}:${frame.id}`)?.(frame);
		},
		{ env: base ? { LOCAL_STUDIO_FLEET_URL: base } : {}, home },
	);
	let seq = 0;
	const ask = (conversation, op, command) =>
		new Promise((resolve) => {
			const id = ++seq;
			waiters.set(`${conversation}:${id}`, resolve);
			r.handle({ type: "eukhe", id, conversation, op, ...(command ? { command } : {}) });
		});
	const events = (conversation) => frames.filter((f) => f.conversation === conversation && f.event).map((f) => f.event);
	return { relay: r, frames, ask, events, home };
}

const until = async (fn, ms, what) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
};

const sse = (res, chunks, { end = true } = {}) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	if (end) res.end("data: [DONE]\n\n");
};
const delta = (content) => ({ choices: [{ delta: { content } }] });

test("the controller's address and key file follow the env, then the controller's own defaults", () => {
	assert.equal(fleetBase({}, "/nowhere"), "http://127.0.0.1:18091/v1");
	assert.equal(fleetBase({ LOCAL_STUDIO_FLEET_URL: "http://100.64.0.9:18091/v1/" }), "http://100.64.0.9:18091/v1");
	assert.equal(fleetKeyPath({ LOCAL_STUDIO_CONTROLLER_HOME: "/c" }, "/h"), "/c/config.json");
	assert.equal(fleetKeyPath({}, "/nowhere"), "/nowhere/.local-studio-controller/config.json");
});

test("fleet_models lists what /v1/models lists, with the fleet key the host read", async (t) => {
	const s = await stub(t, (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: ["auto", "a-1", "b-2", "c-3"].map((id) => ({ id, object: "model" })) }));
	});
	const h = relay(t, s.base);
	const answer = await h.ask("m", "fleet_models");
	assert.deepEqual(answer.result, { base: s.base, models: ["auto", "a-1", "b-2", "c-3"].map((id) => ({ id })) });
	assert.equal(s.seen[0].url, "/v1/models");
	assert.equal(s.seen[0].auth, `Bearer ${KEY}`);
	assert.ok(!JSON.stringify(h.frames).includes(KEY), "no frame to the extension holds the key");
});

test("with no env the host reads the controller's address from the key's config.json", async (t) => {
	const s = await stub(t, (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "auto" }, { id: "z-9" }] }));
	});
	const origin = s.base.replace(/\/v1$/, "");
	for (const url of [origin, `${origin}/`, s.base, `${s.base}/`]) {
		const h = relay(t, undefined, KEY, { url });
		assert.equal(fleetBase({}, h.home), s.base, url);
		const answer = await h.ask("m", "fleet_models");
		assert.deepEqual(answer.result, { base: s.base, models: [{ id: "auto" }, { id: "z-9" }] }, url);
	}
	assert.ok(s.seen.every((r) => r.url === "/v1/models" && r.auth === `Bearer ${KEY}`));
	const h = relay(t, "http://127.0.0.1:1/v1", KEY, { url: origin });
	assert.equal(fleetBase({ LOCAL_STUDIO_FLEET_URL: "http://127.0.0.1:1/v1" }, h.home), "http://127.0.0.1:1/v1");
});

test("a config.json url that is not http(s) falls back to loopback", (t) => {
	for (const url of ["not a url", "ftp://127.0.0.1:18091", "file:///etc/passwd", "javascript:alert(1)", 18091, null, ""]) {
		const h = relay(t, undefined, KEY, { url });
		assert.equal(fleetBase({}, h.home), "http://127.0.0.1:18091/v1", String(url));
	}
	const broken = relay(t, undefined, KEY);
	writeFileSync(join(broken.home, ".local-studio-controller", "config.json"), "{ not json");
	assert.equal(fleetBase({}, broken.home), "http://127.0.0.1:18091/v1");
});

test("a controller that is down is fleet_unreachable at once", async (t) => {
	const s = await stub(t, () => {});
	const closed = s.base.replace(/:\d+\//, ":1/");
	const started = Date.now();
	const answer = await relay(t, closed).ask("m", "fleet_models");
	assert.equal(answer.error.code, "fleet_unreachable");
	assert.ok(Date.now() - started < 4500);
});

test("a 401 names the key file and, on Linux, the restart that fixes it", async (t) => {
	const s = await stub(t, (_req, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "fleet key required" } }));
	});
	const h = relay(t, s.base, null);
	const answer = await h.ask("m", "fleet_models");
	assert.equal(answer.error.code, "fleet_unauthorized");
	assert.match(answer.error.message, /^Fleet key not found/);
	assert.equal(answer.error.path, join(h.home, ".local-studio-controller", "config.json"));
	if (process.platform === "linux") assert.equal(answer.error.fix, "systemctl --user restart local-studio-controller");
	assert.equal(s.seen[0].auth, undefined);
});

test("a 401 or 403 that is not the controller's own key refusal is a fleet_error with its message", async (t) => {
	const cases = [
		[401, { error: { message: "engine says the upstream key is invalid" } }, "engine says the upstream key is invalid"],
		[401, { error: { code: "invalid_api_key", message: "upstream 401" } }, "upstream 401"],
		[403, { error: { code: "UNAUTHORIZED", message: "forbidden by the engine" } }, "forbidden by the engine"],
		[401, "plain refusal", "plain refusal"],
	];
	for (const [status, body, said] of cases) {
		const s = await stub(t, (_req, res) => {
			res.writeHead(status);
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		});
		const answer = await relay(t, s.base).ask("m", "fleet_models");
		assert.equal(answer.error.code, "fleet_error", `${status} ${JSON.stringify(body)}`);
		assert.equal(answer.error.message, `The controller answered ${status}: ${said}`);
		assert.equal(answer.error.path, undefined);
	}
});

test("fleet_chat streams the controller's chunks in order, then fleet_end", async (t) => {
	const s = await stub(t, (_req, res) => sse(res, [delta("one "), delta("two "), delta("three")]));
	const h = relay(t, s.base);
	const answer = await h.ask("c", "fleet_chat", { model: "a-1", messages: [{ role: "user", content: "hi" }], stream: false });
	assert.deepEqual(answer.result, { started: true });
	await until(() => h.events("c").some((e) => e.type === "fleet_end"), 3000, "the end");
	const chunks = h.events("c").filter((e) => e.type === "fleet_chunk").map((e) => e.chunk.choices[0].delta.content);
	assert.deepEqual(chunks, ["one ", "two ", "three"]);
	assert.equal(s.seen[0].url, "/v1/chat/completions");
	assert.equal(s.seen[0].auth, `Bearer ${KEY}`);
	assert.equal(s.seen[0].body.stream, true);
	assert.ok(!JSON.stringify(h.frames).includes(KEY), "no frame to the extension holds the key");
});

test("close mid-stream closes the controller's connection", async (t) => {
	const s = await stub(t, (_req, res) => sse(res, [delta("still going")], { end: false }));
	const h = relay(t, s.base);
	await h.ask("c", "fleet_chat", { model: "a-1", messages: [] });
	await until(() => h.events("c").length, 3000, "the first chunk");
	assert.equal(s.seen[0].closed, false);
	assert.ok(h.relay.has("c"));
	const closed = await h.ask("c", "close");
	assert.deepEqual(closed.result, { closed: true });
	await until(() => s.seen[0].closed, 3000, "the stub's connection to close");
	assert.ok(!h.events("c").some((e) => e.type === "fleet_error"), "a cancel is not an error");
});

test("fleet_chat refuses a request with no model before it reaches the controller", async (t) => {
	const s = await stub(t, (_req, res) => res.end());
	const answer = await relay(t, s.base).ask("c", "fleet_chat", { messages: [] });
	assert.equal(answer.error.code, "bad_params");
	assert.equal(s.seen.length, 0);
});
