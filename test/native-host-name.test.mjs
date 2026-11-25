// Local Studio's native host is com.localstudio.browser. Local Studio's names (com.localstudio.browser, ai.localStudio.bridge) belong to
// Local Studio's helper: the extension never asks for them, so with both installed each extension reaches its own helper.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

test("the extension connects only to Local Studio's host name and retries it after a backoff", async (t) => {
	const fake = installFakeChrome();
	const protocol = await import("../src/bridge/protocol.ts");
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	assert.equal(protocol.NATIVE_HOST_NAME, "com.localstudio.browser");
	assert.deepEqual([...protocol.NATIVE_HOST_NAMES], ["com.localstudio.browser"]);
	const realSetTimeout = globalThis.setTimeout;
	const timers = [];
	globalThis.setTimeout = (fn, ms, ...rest) => {
		const h = realSetTimeout(fn, ms, ...rest);
		timers.push(h);
		return h;
	};
	t.after(() => {
		globalThis.setTimeout = realSetTimeout;
		for (const h of timers) clearTimeout(h);
		for (const p of fake.ports) {
			p.onMessage.listeners.splice(0);
			p.onDisconnect.listeners.splice(0);
		}
	});
	const wait = async (n) => {
		for (let i = 0; i < 300 && fake.ports.length < n; i++) await new Promise((r) => realSetTimeout(r, 5));
		assert.equal(fake.ports.length, n, `expected connect number ${n}`);
	};

	native.startBridge();
	await wait(1);
	assert.equal(fake.ports[0].name, "com.localstudio.browser");
	chrome.runtime.lastError = { message: "Specified native messaging host not found." };
	for (const fn of fake.ports[0].onDisconnect.listeners) fn();
	chrome.runtime.lastError = undefined;
	await new Promise((r) => realSetTimeout(r, 50));
	assert.equal(fake.ports.length, 1, "a missing host is retried after the backoff, not at once");
	await new Promise((r) => realSetTimeout(r, 1200));
	await wait(2);
	assert.equal(fake.ports[1].name, "com.localstudio.browser", "never Local Studio's names");
});
