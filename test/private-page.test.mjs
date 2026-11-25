// A page in an incognito window: the extension says `private` beside its url, so the browser server looks up no skills for it.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

async function startBridge() {
	const fake = installFakeChrome();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	native.startBridge();
	const port = fake.ports[0];
	let nextId = 1;
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "private" } });
	return async (method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId: "c1", id, method, params });
		for (let i = 0; i < 500; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.id === id);
			if (reply) return reply.result;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
}

test("a result naming an incognito tab's page says private, and one naming another tab's does not", async () => {
	const request = await startBridge();
	const made = await request("tabs.create");
	assert.equal("private" in made, false);
	const tab = await chrome.tabs.get(made.tabId);
	assert.equal("private" in (await request("tabs.select", { tabId: made.tabId })), false);
	const get = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ ...(id === made.tabId ? tab : await get(id)), incognito: id === made.tabId });
	assert.equal((await request("tabs.select", { tabId: made.tabId })).private, true);
	assert.equal("private" in (await request("tabs.context")), false, "a result that names no page is left alone");
});

test("a result without a tab goes by the call's tab, and a tab that can't be looked up counts as private", async () => {
	installFakeChrome();
	const { markPrivate } = await import("../src/bridge/private-page.ts");
	const tabs = { 1: { id: 1, incognito: false }, 2: { id: 2, incognito: true } };
	chrome.tabs.get = async (id) => tabs[id] ?? Promise.reject(new Error("No tab"));
	const page = { url: "https://example.com/", title: "x" };
	assert.equal(await markPrivate("snapshot", page, 1), page);
	assert.deepEqual(await markPrivate("snapshot", page, 2), { ...page, private: true });
	assert.deepEqual(await markPrivate("text", { ...page, tabId: 2 }, 1), { ...page, tabId: 2, private: true });
	assert.deepEqual(await markPrivate("html", page, 3), { ...page, private: true });
	assert.deepEqual(await markPrivate("html", page), { ...page, private: true });
	assert.equal(await markPrivate("evaluate", page, 2), page, "a script's own value");
});
