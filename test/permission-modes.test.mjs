// The permission mode's one store and its migration from 1.4.0 (docs/decisions.md, D67): "ask" becomes Manual,
// "allow_all" becomes Yolo, nothing stored (or "Match the model") becomes Auto with a one-time notice, and a fresh
// install is Auto with no notice.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	asPermissionMode,
	dismissModeNotice,
	getModeNotice,
	getPermissionMode,
	LEGACY_MODE_KEY,
	MODE_KEY,
	MODE_NOTICE_KEY,
	migrateLegacyMode,
	setPermissionMode,
	startFreshInstall,
} from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const stored = async (key) => (await chrome.storage.local.get(key))[key];

test("migration: a stored ask becomes Manual, with no notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "ask" });
	assert.equal(await getPermissionMode(), "manual");
	assert.equal(await stored(MODE_KEY), "manual", "the new store holds it");
	assert.equal(await getModeNotice(), undefined);
});

test("migration: a stored allow_all becomes Yolo, with no notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await getPermissionMode(), "yolo");
	assert.equal(await getModeNotice(), undefined);
});

test("migration: an update with nothing stored becomes Auto, and the side panel gets a notice once", async () => {
	installFakeChrome();
	assert.equal(await getPermissionMode(), "auto");
	const notice = await getModeNotice();
	assert.equal(notice?.from, "unset");
	assert.equal(typeof notice?.at, "number");
	// Read again: no second migration, the notice is the same one.
	assert.equal(await getPermissionMode(), "auto");
	assert.deepEqual(await getModeNotice(), notice);
	await dismissModeNotice();
	assert.equal(await getModeNotice(), undefined);
	assert.equal(await getPermissionMode(), "auto");
	assert.equal(await getModeNotice(), undefined, "a dismissed notice never comes back");
});

test("migration: 1.4.0's stored Match the model becomes Auto, with the notice", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "by_model" });
	assert.equal(await getPermissionMode(), "auto");
	assert.equal((await getModeNotice())?.from, "by_model");
});

test("a fresh install is Auto with no notice, even when something read the mode first", async () => {
	installFakeChrome();
	await startFreshInstall();
	assert.equal(await getPermissionMode(), "auto");
	assert.equal(await getModeNotice(), undefined);
	installFakeChrome();
	assert.equal(await getPermissionMode(), "auto");
	await startFreshInstall();
	assert.equal(await getModeNotice(), undefined, "onInstalled takes back a notice an early read left");
	assert.equal(await stored(MODE_KEY), "auto");
});

test("startFreshInstall leaves an install that has a 1.4.0 setting alone", async () => {
	installFakeChrome();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "ask" });
	await startFreshInstall();
	assert.equal(await getPermissionMode(), "manual");
});

test("choosing a mode takes the notice away; a chosen mode is never migrated again", async () => {
	installFakeChrome();
	await getPermissionMode();
	assert.ok(await getModeNotice());
	await setPermissionMode("manual");
	assert.equal(await getModeNotice(), undefined);
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await getPermissionMode(), "manual", "the old key no longer decides");
});

test("a migration whose first read came before a choice never overwrites it: Manual chosen meanwhile stays Manual", async () => {
	installFakeChrome();
	const get = chrome.storage.local.get.bind(chrome.storage.local);
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	let paused = false;
	// The first read sees no mode yet, then waits (a status request from the CLI, say) while the person picks Manual.
	chrome.storage.local.get = async (keys) => {
		const data = await get(keys);
		if (!paused) {
			paused = true;
			await gate;
		}
		return data;
	};
	const reading = getPermissionMode();
	while (!paused) await new Promise((r) => setImmediate(r));
	await setPermissionMode("manual");
	release();
	assert.equal(await reading, "manual");
	assert.equal(await stored(MODE_KEY), "manual", "the migration did not write Auto over the choice");
	assert.equal(await getModeNotice(), undefined, "and did not bring the notice back");
	chrome.storage.local.get = get;
});

/** One exclusive lock per name, as navigator.locks gives every context of one extension. */
function fakeLocks() {
	const tails = new Map();
	const asked = [];
	return {
		asked,
		request(name, options, work) {
			asked.push([name, options?.mode]);
			const run = (tails.get(name) ?? Promise.resolve()).then(() => work({ name }));
			tails.set(name, run.catch(() => undefined));
			return run;
		},
	};
}

/** Give every module instance these locks for one test; set the result's `locks` to undefined for a browser without them. */
function withLocks(t, locks) {
	const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const navigator = { locks };
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
	t.after(() => (before ? Object.defineProperty(globalThis, "navigator", before) : delete globalThis.navigator));
	return navigator;
}

/** The module as another extension context has it: its own state, the same storage and the same locks. */
const context = (name) => import(`../src/bridge/permissions.ts?context=${name}-${Date.now()}`);
const ticks = async (n = 50) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test("a migration paused after its last read never overwrites Manual picked in another context", async (t) => {
	installFakeChrome();
	const locks = fakeLocks();
	withLocks(t, locks);
	const worker = await context("worker");
	const panel = await context("panel");
	const get = chrome.storage.local.get.bind(chrome.storage.local);
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	let reads = 0;
	// The migration's second read is the one it decides on: hold it there, with "no mode stored" in hand.
	chrome.storage.local.get = async (keys) => {
		const data = await get(keys);
		if (++reads === 2) await gate;
		return data;
	};
	const migrating = worker.getPermissionMode();
	while (reads < 2) await ticks(1);
	const choosing = panel.setPermissionMode("manual");
	await ticks();
	release();
	await Promise.all([migrating, choosing]);
	assert.equal(await stored(MODE_KEY), "manual", "the migration landed after the choice and put Auto back");
	assert.equal(await getModeNotice(), undefined, "and the notice about Auto is gone");
	assert.equal(await worker.getPermissionMode(), "manual");
});

test("every mode write takes the one exclusive lock; without Web Locks the writes still work", async (t) => {
	installFakeChrome();
	const locks = fakeLocks();
	const navigator = withLocks(t, locks);
	const m = await context("writes");
	const held = async (write) => {
		const before = locks.asked.length;
		await write();
		return locks.asked.slice(before);
	};
	const lock = [["local-studio-permission-mode", "exclusive"]];
	assert.deepEqual(await held(() => m.getPermissionMode()), lock, "migration");
	assert.deepEqual(await held(() => m.getPermissionMode()), [], "a plain read takes no lock");
	assert.deepEqual(await held(() => m.startFreshInstall()), lock, "a fresh install");
	for (const mode of ["manual", "auto", "yolo"]) assert.deepEqual(await held(() => m.setPermissionMode(mode)), lock, mode);
	// Nothing else in the extension writes the key: the CLI's permission.setMode calls setPermissionMode.
	const source = read("src/bridge/permissions.ts");
	assert.equal(source.match(/\[MODE_KEY\]: /g).length, 3, "a new write of the mode belongs inside the lock");
	navigator.locks = undefined;
	const plain = await context("plain");
	await plain.setPermissionMode("manual");
	assert.equal(await plain.getPermissionMode(), "manual");
});

test("what Auto is said to do is what this build does: asks and site checks are named only once they are wired", async () => {
	installFakeChrome();
	const { MODE_NOTICE_TEXT } = await import(`../src/components/ModeNotice.ts?ctx=${Date.now()}`);
	const { modeSummary } = await import("../cli/src/permission-mode.ts");
	const help = read("src/dialogs/BridgeTab.ts").match(/mode: "auto",[^}]*?help: "([^"]+)"/)?.[1];
	// Calls in code; a name in a comment wires nothing.
	const code = ["src/bridge/native.ts", "src/bridge/permissions.ts"].map((p) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).join("\n");
	const asksActions = /\bactionRisk\(/.test(code);
	const checksSites = /\bsensitiveSite\(/.test(code);
	for (const [where, text] of Object.entries({ notice: MODE_NOTICE_TEXT, settings: help, cli: modeSummary("auto") })) {
		assert.match(text, /frontier models open (any site|ordinary sites)/, where);
		if (/\b(sends?|posts?|buys?|deletes?|risky)\b/i.test(text)) assert.ok(asksActions, `${where} promises action asks the bridge never makes: ${text}`);
		if (/\b(ordinary|sensitive|mail|banks?)\b/i.test(text)) assert.ok(checksSites, `${where} promises a site check nothing makes: ${text}`);
	}
});

test("mode names: the three modes, and the 1.4.0 names an older CLI sends", () => {
	assert.deepEqual(
		["manual", "auto", "yolo", "ask", "allow_all", "by_model"].map(asPermissionMode),
		["manual", "auto", "yolo", "manual", "yolo", "auto"],
	);
	for (const v of [undefined, null, "", "MANUAL", "full", 1]) assert.equal(asPermissionMode(v), undefined, String(v));
	assert.deepEqual(migrateLegacyMode("ask"), { mode: "manual" });
	assert.deepEqual(migrateLegacyMode("allow_all"), { mode: "yolo" });
	assert.deepEqual(migrateLegacyMode(undefined), { mode: "auto", notice: "unset" });
	assert.deepEqual(migrateLegacyMode("garbage"), { mode: "auto", notice: "unset" });
});

test("the worker starts a fresh install in Auto, and the bridge takes the new and old names", () => {
	assert.match(read("src/background.ts"), /details\.reason === "install"\) startFreshInstall\(\)/);
	const native = read("src/bridge/native.ts");
	assert.match(native, /const mode = asPermissionMode\(message\.params\?\.mode\);/);
	assert.match(native, /mode must be manual, auto or yolo/);
	assert.ok(MODE_NOTICE_KEY && MODE_KEY !== LEGACY_MODE_KEY);
});

test("the side panel shows the notice once, and its button switches to Manual", async () => {
	installFakeChrome();
	const { MODE_NOTICE_TEXT, modeNotice, watchModeNotice } = await import(`../src/components/ModeNotice.ts?ctx=${Date.now()}`);
	let changes = 0;
	await watchModeNotice(() => changes++);
	const card = modeNotice();
	assert.ok(card.strings.join("").includes("Switch to Manual"), "the card offers Manual");
	assert.match(MODE_NOTICE_TEXT, /Auto mode/);
	const [toManual] = card.values.filter((v) => typeof v === "function");
	await toManual();
	assert.equal(await getPermissionMode(), "manual");
	assert.equal(await getModeNotice(), undefined);
	assert.ok(changes >= 2, "the panel redraws when the notice goes");
	assert.equal(typeof modeNotice(), "symbol", "the card is gone (lit's nothing)");
	const panel = read("src/sidepanel.ts");
	assert.match(panel, /\$\{updateNotice\(\)\}\s*\$\{modeNotice\(\)\}/, "drawn under the update notice");
	const [, restored, fresh] = panel.split("thinkingLevel: sessionData.thinkingLevel,").flatMap((part, i) => (i ? part.split("// No session - create new agent") : [part]));
	assert.match(restored, /watchModeNotice\(renderApp\)/, "a restored chat shows it too");
	assert.match(fresh, /watchModeNotice\(renderApp\)/);
});
