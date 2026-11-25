// A click that opens a tab says so even when the tab joins the session late (#75), and waits for nothing else.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

function noEvents() {
	const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
	chrome.tabs.onActivated ??= ev();
	chrome.webNavigation.onCommitted ??= ev();
}

// #75: at load 170 a target=_blank click answered effect "nothing": the tab joined the session after the quiet window.
test("a click's report waits for the tab it opened to join the session, past the quiet window", async () => {
	const fake = installFakeChrome();
	noEvents();
	// The bridge's long timers must not keep the test process alive.
	const setTimeoutReal = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = setTimeoutReal(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	const { startBridge } = await import("../src/bridge/native.ts");
	startBridge();
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId: "c1", id, method, params, guardedHosts: [] });
		for (let i = 0; i < 2000; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === "c1" && m.id === id);
			if (reply) return reply;
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "new-tab" } });
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	const { BrowserSession } = await import("../src/browser/session.ts");
	const { result: created } = await request("tabs.create");
	const tabId = created.tabId;
	await chrome.tabs.update(tabId, { url: "https://example.com/", status: "complete" });
	let opened;
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
			for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, "Page.windowOpen", { url: "https://example.com/new", userGesture: true });
			setTimeout(async () => {
				opened = fake.addTab({ url: "https://example.com/new", status: "complete" });
				await (await BrowserSession.openOwnerOf(tabId)).adopt(opened, true);
			}, 1000);
		}
		return send(target, method, params);
	};
	const { result, error } = await request("click", { x: 10, y: 10 });
	assert.equal(error, undefined, JSON.stringify(error));
	assert.deepEqual(result.newTabs?.map((t) => t.tabId), [opened], JSON.stringify(result));
	assert.ok(result.effect.includes("newTab"), JSON.stringify(result.effect));
});

test("newTabJoins waits only for a tab the page could open, and no longer than 2 s", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { newTabJoins, settleStart } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	const since = await settleStart(tabId);
	const emit = (method, params) => {
		for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, method, params);
	};
	const timed = async (joined = () => false, stop = () => false, from = since) => {
		const t = Date.now();
		await newTabJoins(tabId, from, joined, stop);
		return Date.now() - t;
	};
	assert.ok((await timed()) < 100, "nothing opened");
	emit("Page.windowOpen", { url: "https://example.com/ad", userGesture: false });
	assert.ok((await timed()) < 100, "a blocked popup");
	emit("Page.windowOpen", { url: "https://example.com/new", userGesture: true });
	assert.ok((await timed(() => true)) < 100, "already joined");
	assert.ok((await timed(undefined, () => true)) < 100, "aborted");
	assert.ok((await timed(undefined, undefined, Date.now() + 1000)) < 100, "opened before this action");
	const never = await timed();
	assert.ok(never > 1000 && never < 2500, `${never} ms`);
	assert.ok((await timed()) < 100, "the wait runs from the opening");
});
