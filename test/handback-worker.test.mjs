// The hand-back in the service worker (src/handback/worker.ts): an agent that gave up before its hand-back arrived never
// shows a card, and one that gives up while it arrives neither.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const record = { label: "Agent · claude", color: "blue" };

// Long enough for every step here; a wait nothing ends fails its test instead of holding it.
globalThis.__LOCAL_STUDIO_BROWSER_HANDBACK_MS = 3_000;
let ctx = 0;
async function start() {
	const fake = installFakeChrome();
	await chrome.tabs.create({ url: "https://example.com/" });
	const [tab] = await chrome.tabs.query({});
	const session = { id: "s1", tabIds: [tab.id], currentTabId: tab.id, record };
	const worker = await import(`../src/handback/worker.ts?ctx=${++ctx}`);
	worker.startHandback();
	return { fake, tab, worker, ask: (clientId, waitId) => worker.handleHandback({ clientId, session }, { reason: "Sign in", waitId }) };
}

const pending = async () => (await chrome.storage.session.get("handback_pending")).handback_pending ?? [];

test("a cancel that beats its hand-back in ends it unseen, for that client and call alone", async () => {
	const b = await start();
	assert.equal(b.worker.cancelHandback("c1", "w"), 0);
	assert.equal((await b.ask("c1", "w")).status, "aborted");
	assert.deepEqual(await pending(), []);

	b.worker.cancelHandback("c1", "w2");
	const theirs = b.ask("c2", "w2");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal((await pending()).length, 1, "another client's call of the same name waits");
	assert.equal((await b.ask("c1", "w2")).status, "aborted");
	assert.equal((await pending()).length, 1, "a call already given up takes no other call's place");
	assert.equal(b.worker.cancelHandback("c2", "w2"), 1);
	assert.equal((await theirs).status, "aborted");

	b.worker.cancelHandback("c1", "w3");
	b.worker.cancelHandbacksFor("c1");
	assert.equal((await b.ask("c1", "w3")).status, "aborted", "Ctrl-C: the cancel, then the disconnect, then the call");
	assert.deepEqual(await pending(), []);
});

/** Runs `then` once, while the worker looks the next hand-back's tab up. */
function whileLookingUp(then) {
	const get = chrome.tabs.get;
	chrome.tabs.get = async (id) => {
		chrome.tabs.get = get;
		then();
		return get(id);
	};
}

test("a cancel, its client leaving, or both while the hand-back looks its tab up end it unseen", async () => {
	const b = await start();
	const first = b.ask("c0", "first");
	await new Promise((r) => setTimeout(r, 100));
	whileLookingUp(() => b.worker.cancelHandback("c1", "w"));
	assert.equal((await b.ask("c1", "w")).status, "aborted");
	whileLookingUp(() => b.worker.cancelHandbacksFor("c1"));
	assert.equal((await b.ask("c1", "w2")).status, "disconnected");
	whileLookingUp(() => {
		b.worker.cancelHandback("c1", "w3");
		b.worker.cancelHandbacksFor("c1");
	});
	assert.equal((await b.ask("c1", "w3")).status, "aborted");
	assert.deepEqual((await pending()).map((p) => p.clientId), ["c0"], "none took the place of the one that waits");
	b.worker.cancelHandback("c0", "first");
	assert.equal((await first).status, "aborted");
});
