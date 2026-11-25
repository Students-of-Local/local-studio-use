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
const { installCdpListeners, keepDrawing, KEEP_DRAWING_MS } = await import("../src/browser/cdp.ts");
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
