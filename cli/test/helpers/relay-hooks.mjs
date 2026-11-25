// Preloaded with `node --import` by cli/test/relay-remote.test.mjs, never by the CLI itself: setup's end-to-end check through the
// relay, sent to a local stand-in, because no relay stands behind a test's workers.dev address. The relay's own health answer says
// a connector is there, or with RELAY_HOOK_STATE, when that state file says so; every other path goes to serve's stand-in on RELAY_HOOK_PORT. A normal run has no way to load it.
import { readFileSync } from "node:fs";

globalThis[Symbol.for("local-studio.remote-test.hooks")] = {
	relayFetch: async (url, init) => {
		const { pathname } = new URL(url);
		const state = process.env.RELAY_HOOK_STATE;
		const connected = !state || JSON.parse(readFileSync(state, "utf8")).state === "connected";
		if (pathname === "/_relay/health") return new Response(JSON.stringify({ ok: true, connected }), { headers: { "content-type": "application/json" } });
		return fetch(`http://127.0.0.1:${process.env.RELAY_HOOK_PORT}${pathname}`, init);
	},
};
