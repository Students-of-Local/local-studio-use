// One set of chats in the side panel and the Local Studio app, end to end: the built extension in a throwaway headless
// Chromium, the real native host, and Local Studio's session store (a stand-in, or the real daemon with
// LOCAL_STUDIO_BROWSER_TEST_EUKHE=<program>, helpers/eukhe-store.mjs). Builds as e2e-eukhe.test.mjs says.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHarness, until } from "./e2e-harness.mjs";
import { startWorld } from "./helpers/eukhe-store.mjs";

const PANEL = `chrome-extension://${extensionId.id}/sidepanel.html`;
const CHAT = "3f2b8c1e-8f5d-4b6a-9d0e-1a2b3c4d5e6f";

/** A chat as the panel saves it, put in its database, and the note its store sends. */
const SEED = (at) => `(async () => {
	const db = await new Promise((resolve, reject) => {
		const req = indexedDB.open("local-studio-storage");
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	const now = new Date(${at}).toISOString();
	const base = { id: "${CHAT}", title: "Hotels in Lisbon", createdAt: now, lastModified: now };
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const tx = db.transaction(["sessions", "sessions-metadata"], "readwrite");
	tx.objectStore("sessions-metadata").put({ ...base, messageCount: 2, usage, thinkingLevel: "off", preview: "Find hotels" });
	tx.objectStore("sessions").put({ ...base, model: null, thinkingLevel: "off", messages: [
		{ role: "user", content: [{ type: "text", text: "Find hotels MARKPANEL" }], timestamp: ${at} },
		{ role: "assistant", content: [{ type: "text", text: "Three options from the panel." }], api: "openai-completions", provider: "stub", model: "stub-model", usage, stopReason: "stop", timestamp: ${at} + 5 },
	] });
	await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
	db.close();
	chrome.runtime.sendMessage({ type: "local-studio-thread-changed", id: "${CHAT}" });
	return true;
})()`;

test("a panel chat goes on in the app and comes back, and the app's own thread opens in the panel", { skip: process.platform === "win32" && "Local Studio is not on Windows yet", timeout: 180_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "chats-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const world = await startWorld(root);
	t.after(() => world.close());
	// Set before the browser starts, so the host Chromium spawns inherits them.
	const set = { EUKHE_DAEMON_SOCKET: world.path, EUKHE_CODING_AGENT_DIR: world.agent, LOCAL_STUDIO_DATA_DIR: join(root, "app") };
	const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
	Object.assign(process.env, set);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
	const h = await startHarness({ name: "chat-sync-e2e" });
	t.after(() => h.stop());
	await h.connected();

	const open = async (url) => {
		const version = await (await fetch(`http://${h.devtools}/json/version`)).json();
		const { targetId } = await h.cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url });
		return async (expression) => {
			const target = (await h.targets()).find((x) => x.id === targetId);
			const r = await h.cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			return r.result.value;
		};
	};
	const shows = (panel, text) => until(async () => (await panel("document.body.innerText")).includes(text), 30_000, `"${text}" in the panel`);

	// A chat of the panel's becomes a thread the app lists.
	const panel = await open(PANEL);
	await until(() => panel(`!!document.querySelector("textarea")`), 30_000, "the panel");
	await panel(SEED(Date.now()));
	const listed = async () => (await world.app.call({ type: "list_saved_sessions", cwd: world.home, scope: null })).sessions;
	await until(async () => (await listed()).length === 1, 30_000, "the chat in the app's list");
	const [row] = await listed();
	assert.equal(row.name, "Hotels in Lisbon");
	const sid = row.id;
	assert.ok(existsSync(join(world.sessions, sid)) || existsSync(join(world.sessions, `${sid}.jsonl`)));

	// The panel shows that chat; a turn in the app lands in it without a reload.
	await panel(`location.href = "${PANEL}?session=${CHAT}"; true`).catch(() => undefined);
	await shows(panel, "Three options from the panel.");
	await world.turn(sid, "Cheaper MARKAPP");
	const reply = (await world.messages(sid)).at(-1).content.find((c) => c.type === "text").text;
	await shows(panel, "Cheaper MARKAPP");
	await shows(panel, reply);
	await world.end(sid);

	// The app's own thread is in Past chats, and opens as a chat of the panel's; the app's stays as it was.
	const { activeSessionId } = await world.app.call({ type: "create", config: { cwd: world.home, provider: "stub", model: "stub-model" } });
	const ownSid = (await world.app.call({ type: "list" })).sessions.find((s) => s.activeSessionId === activeSessionId).sessionId;
	await world.turn(ownSid, "Plan the garden MARKOWN");
	const before = (await world.messages(ownSid)).length;
	const list = () =>
		panel(`(async () => {
			const answer = await chrome.runtime.sendMessage({ type: "local-studio-app-threads", query: "" });
			return (answer?.threads ?? []).map((x) => [x.id, x.title]);
		})()`);
	await until(async () => (await list()).length === 1, 30_000, "the app's thread offered to the panel").catch(async (err) => assert.fail(`${err.message}: ${JSON.stringify(await list())}`));
	await panel(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /past chats|chats/i.test(x.title + x.ariaLabel)); if (!b) throw new Error([...document.querySelectorAll("button")].map((x) => x.title || x.ariaLabel).join("|")); b.click(); return true; })()`);
	await until(() => panel(`!!document.querySelector("li[data-thread]")`), 20_000, "the app's thread in Past chats");
	await panel(`document.querySelector("li[data-thread] button").click(); true`);
	await shows(panel, "Plan the garden MARKOWN");
	assert.notEqual(await panel(`new URLSearchParams(location.search).get("session")`), CHAT);
	assert.equal((await world.messages(ownSid)).length, before, "the app's thread is untouched");

	// Opened once, it is not offered a second time.
	await until(async () => (await panel("document.readyState")) === "complete", 10_000, "the panel again");
	await panel(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /past chats|chats/i.test(x.title + x.ariaLabel)); b.click(); return true; })()`);
	await until(async () => (await panel(`document.querySelectorAll("li[data-session]").length`)) >= 2, 20_000, "both chats");
	assert.equal(await panel(`document.querySelectorAll("li[data-thread]").length`), 0);
});
