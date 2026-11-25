// The frame keeper (D62): the 1x1 cast that keeps an agent's hidden tab drawing must always stop KEEP_DRAWING_MS after
// the last action, and a failed start must not leave the next action without a cast.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const noEvent = () => ({ addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= noEvent();
chrome.webNavigation ??= {};
chrome.webNavigation.onCommitted ??= noEvent();
const { cdpSend, detachTab, ensureCapture, installCdpListeners, keepDrawing, KEEP_DRAWING_MS } = await import("../src/browser/cdp.ts");
installCdpListeners();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record every cast start and stop; `failStart(tabId)` gives the next start's error, if any. */
function castLog(failStart) {
	const log = [];
	chrome.debugger.sendCommand = async ({ tabId }, method) => {
		if (method === "Page.startScreencast") {
			const err = failStart(tabId);
			log.push(`${tabId} start${err ? " failed" : ""}`);
			if (err) throw new Error(err);
		}
		if (method === "Page.stopScreencast") log.push(`${tabId} stop`);
		return {};
	};
	return log;
}

test("a keeper cast started across a reattach still stops after KEEP_DRAWING_MS", { timeout: KEEP_DRAWING_MS + 5000 }, async () => {
	let first = true;
	const log = castLog(() => {
		if (!first) return undefined;
		first = false;
		return "Debugger is not attached to the tab with id: 7.";
	});
	await keepDrawing(7);
	assert.deepEqual(log, ["7 start failed", "7 start"]);
	await sleep(KEEP_DRAWING_MS + 200);
	assert.deepEqual(log, ["7 start failed", "7 start", "7 stop"]);
});

test("after a start fails while a second action waits on it, the next action starts the cast", async () => {
	let fails = 1;
	const log = castLog(() => (fails-- > 0 ? "Internal error" : undefined));
	await Promise.all([keepDrawing(8), keepDrawing(8)]);
	assert.deepEqual(log, ["8 start failed"]);
	await keepDrawing(8);
	assert.deepEqual(log, ["8 start failed", "8 start"]);
});

/** A debugger other clients share: `own` is this extension's attachment, and getTargets says attached either way. */
function sharedDebugger(own) {
	const log = { attached: 0, own };
	chrome.debugger.getTargets = async () => [{ tabId: 9, attached: true }];
	chrome.debugger.attach = async () => {
		log.attached++;
		if (log.own || log.refused) throw new Error("Another debugger is already attached to the tab with id: 9.");
		log.own = true;
	};
	chrome.debugger.detach = async () => {
		log.own = false;
	};
	chrome.debugger.sendCommand = async () => {
		if (!log.own) throw new Error("Debugger is not attached to the tab with id: 9.");
		return { answered: true };
	};
	return log;
}

test("a tab DevTools is already on is attached to; our own attachment from before a restart is used; a refusal is said", async () => {
	const devtools = sharedDebugger(false);
	assert.deepEqual(await cdpSend(9, "DOM.enable"), { answered: true });
	assert.equal(devtools.attached, 1);
	// Our debugger left unannounced while DevTools stayed: the next capture read sees it and attaches again.
	await ensureCapture(9, "console");
	devtools.own = false;
	assert.match((await ensureCapture(9, "console"))?.stopped[0].reason ?? "no gap", /no longer attached/);
	await detachTab(9);
	const restarted = sharedDebugger(true);
	assert.deepEqual(await cdpSend(9, "DOM.enable"), { answered: true });
	assert.equal(restarted.attached, 1);
	await detachTab(9);
	sharedDebugger(false).refused = true;
	await assert.rejects(cdpSend(9, "DOM.enable"), /Cannot attach to tab 9: Another debugger is already attached/);
});
