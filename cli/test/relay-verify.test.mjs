// The end-to-end check of `remote setup` on the relay route (cli/src/relay-verify.ts), against local servers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const mod = await loadTs(`export { verify } from "@src/relay-verify.ts";`);

/** A local stand-in for the relay's two health answers. */
async function healthServer({ connected = true, health = 200 } = {}) {
	const seen = [];
	const srv = createServer((req, res) => {
		seen.push(req.url);
		res.setHeader("content-type", "application/json");
		if (req.url === "/_relay/health") return res.end(JSON.stringify({ ok: true, connected }));
		res.statusCode = health;
		res.end(JSON.stringify({ ok: health === 200 }));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}

test("verify waits for the connector, then needs /v1/health back from serve", async () => {
	const good = await healthServer();
	const none = await healthServer({ connected: false });
	const down = await healthServer({ health: 502 });
	try {
		assert.deepEqual(await mod.verify(good.url, Date.now() + 1000, 10), { ok: true });
		assert.deepEqual(good.seen, ["/_relay/health", "/v1/health"]);
		const waiting = await mod.verify(none.url, Date.now() + 60, 10);
		assert.equal(waiting.code, "relay_connector");
		assert.ok(!none.seen.includes("/v1/health"), "no health check before the connector is there");
		const broken = await mod.verify(down.url, Date.now() + 60, 10);
		assert.equal(broken.code, "relay_health");
		assert.match(broken.message, /answered 502/);
	} finally {
		await Promise.all([good.close(), none.close(), down.close()]);
	}
});

test("a connector that drops after it was seen is the relay's report, not serve's", async () => {
	let asked = 0;
	const fetch = async (url) => (url.endsWith("/_relay/health") ? Response.json({ ok: true, connected: ++asked === 1 }) : new Response("", { status: 502 }));
	const gone = await mod.verify("https://relay.test", Date.now() + 500, 10, { fetch });
	assert.equal(gone.code, "relay_connector");
	assert.ok(asked > 1);
});

test("it keeps trying through a name that doesn't resolve yet and a connector that isn't there yet, and says what stopped it", async () => {
	const down = async () => {
		throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND relay.test"), { code: "ENOTFOUND" }) });
	};
	const answers = [down, async () => Response.json({ connected: true }, { status: 503 }), async () => Response.json({ connected: false }), async () => Response.json({ connected: true }), async () => Response.json({ page: 1 }), async () => Response.json({ connected: true }), async () => Response.json({ ok: true })];
	assert.deepEqual(await mod.verify("https://relay.test", Date.now() + 5_000, 1, { fetch: () => answers.shift()() }), { ok: true });
	assert.equal(answers.length, 0);
	const never = await mod.verify("https://relay.test", Date.now() + 20, 10, { fetch: down });
	assert.equal(never.code, "relay_connector");
	assert.match(never.message, /ENOTFOUND/);
});
