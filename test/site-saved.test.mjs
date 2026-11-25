// Site changes kept outside the browser that made them, what an agent may change in place, and the list behind the cards.
// Whatever comes back in is checked again, and a script always comes back off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const store = await import("../src/site-edits/store.ts");
const { sitesDocument, withDocument } = await import("../src/site-edits/saved.ts");
const { CARD_MS, CHANGES_KEY, clearChanges, noteChange, openChanges } = await import("../src/site-edits/changes.ts");
const { GUARDED_KEY, guardedHosts, onHostSites, startSiteKeeper } = await import("../src/site-edits/keeper.ts");
const { readyMadeEdit, readyMadeFor } = await import("../src/site-edits/ready-made.ts");
const { changeTitle } = await import("../src/site-edits/words.ts");
const empty = { edits: [], adBlock: false };
let n = 0;
const newId = () => `n${++n}`;
const doc = (...edits) => ({ localStudioSites: 1, adBlock: false, edits });
const hide = { host: "x.com", kind: "hide", value: ".ad", note: "", on: true, addedBy: "agent:Claude" };
const fresh = () => {
	const f = installFakeChrome();
	globalThis.chrome.runtime = { ...(globalThis.chrome.runtime ?? {}), getManifest: () => ({ version: "0" }) };
	return f;
};

test("a document adds its edits as new ones, keeps who and off, and a script arrives off", () => {
	const r = withDocument(
		empty,
		doc(
			hide,
			{ ...hide, value: ".off", on: false, addedBy: "you" },
			{ host: "x.com", kind: "script", value: "document.title = 1", note: "", on: true, addedBy: "you" },
			{ host: "youtube.com", kind: "style", value: "a { color: red }", note: "Red", on: true, addedBy: "robot:evil" },
		),
		[],
		newId,
		5,
	);
	assert.equal(r.added, 4);
	assert.equal(r.leftOut, 0);
	assert.deepEqual(
		r.state.edits.map((e) => [e.kind, e.on, e.addedBy, e.createdAt]),
		[["hide", true, "agent:Claude", 5], ["hide", false, "you", 5], ["script", false, "you", 5], ["style", true, "you", 5]],
	);
	assert.equal(r.state.edits[3].value, "a { color: red !important; }", "a style is checked and rewritten on the way in");
	assert.ok(r.state.edits.every((e) => /^n\d/.test(e.id)), "no id from outside is kept");
});

test("an entry that fails a check is left out and counted; one already here is neither", () => {
	const bad = [
		{ ...hide, host: "mybank.example" },
		{ ...hide, host: "co.uk" },
		{ ...hide, host: "" },
		{ ...hide, value: "a { } b" },
		{ ...hide, kind: "style", value: "a { background: url(https://e/x) }" },
		{ ...hide, kind: "root" },
		null,
		7,
	];
	const r = withDocument(empty, doc(hide, ...bad, { ...hide }), ["login.mybank.example"], newId, 1);
	assert.equal(r.added, 1);
	assert.equal(r.leftOut, bad.length);
	const two = withDocument(empty, doc(hide, { ...hide, host: "reddit.com" }, { ...hide, kind: "nope" }), [], newId, 1);
	assert.deepEqual([two.added, two.leftOut], [2, 1]);
});

test("anything else is no document, and the state is not touched", () => {
	for (const raw of [undefined, null, 4, "x", [], {}, { localStudioSites: 2, edits: [] }, { localStudioSites: 1, edits: "x" }])
		assert.equal(withDocument(empty, raw, [], newId, 1), undefined);
});

test("Export is the whole list, or one site's without the ad block setting", () => {
	const state = withDocument({ edits: [], adBlock: true }, doc(hide, { ...hide, host: "reddit.com" }), [], newId, 1).state;
	assert.equal(sitesDocument(state).edits.length, 2);
	assert.equal(sitesDocument(state).adBlock, true);
	const one = sitesDocument(state, "x.com");
	assert.deepEqual(one.edits.map((e) => e.host), ["x.com"]);
	assert.equal(one.adBlock, false);
	assert.equal(withDocument(empty, JSON.parse(JSON.stringify(one)), [], newId, 1).added, 1, "what Export writes, Import reads");
});

test("a browser with no changes of its own takes the saved ones; one that ever had a change keeps its own", async () => {
	fresh();
	const sent = [];
	startSiteKeeper((m) => sent.push(m) > 0);
	const saved = { ...doc(hide, { ...hide, kind: "script", value: "1", on: true }), adBlock: true };
	await onHostSites({ type: "sites_saved", saved, guardedHosts: ["bank.example", 5] });
	const taken = await store.load();
	assert.deepEqual(taken.edits.map((e) => [e.kind, e.on]), [["hide", true], ["script", false]]);
	assert.equal(taken.adBlock, true);
	assert.deepEqual(await guardedHosts(), ["bank.example"]);
	assert.deepEqual(sent.at(-1), { type: "sites", edits: taken.edits, adBlock: true });
	// The person removes all of them: an empty list is a list, and the saved ones don't come back.
	await store.change(() => ({ state: { edits: [], adBlock: false }, result: undefined }));
	await onHostSites({ type: "sites_saved", saved, guardedHosts: [] });
	assert.deepEqual((await store.load()).edits, []);
	assert.deepEqual(sent.at(-1).edits, [], "and the helper is told");
});

test("a saved list that isn't one is not taken, and nothing is sent until there is a change", async () => {
	fresh();
	const sent = [];
	startSiteKeeper((m) => sent.push(m) > 0);
	await onHostSites({ type: "sites_saved", guardedHosts: [] });
	assert.equal(store.STORAGE_KEY in (await chrome.storage.local.get()), false, "no saved list: the browser stays one that never had a change");
	assert.deepEqual(sent, []);
	await store.change((s) => ({ state: store.added(s, { host: "x.com", kind: "hide", value: ".a", actor: "person", who: "" }, "a", 1).state, result: undefined }));
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(sent.map((m) => m.edits.length), [1], "one send for the change");
	assert.deepEqual((await chrome.storage.local.get(GUARDED_KEY))[GUARDED_KEY], []);
});

test("cards list what agents changed for a minute; a script waits for an answer", async () => {
	fresh();
	const edit = (id, kind) => ({ id, host: "x.com", kind, value: "v", note: "", on: true, addedBy: "agent:Claude", createdAt: 1 });
	await noteChange(edit("a", "style"), "Claude", { value: "first", note: "" });
	await noteChange(edit("a", "style"), "Claude", { value: "second", note: "" });
	await noteChange(edit("b", "script"), "Claude");
	await noteChange(edit("c", "hide"), "Claude");
	await noteChange(edit("c", "hide"), "Claude", { value: "x", note: "" });
	const raw = (await chrome.storage.session.get(CHANGES_KEY))[CHANGES_KEY];
	const now = Date.now();
	assert.deepEqual(openChanges(raw, now).map((c) => c.id).sort(), ["a", "b", "c"]);
	assert.equal(raw.find((c) => c.id === "a").before.value, "first", "Undo goes back to before the first change");
	assert.equal(raw.find((c) => c.id === "c").before, undefined, "an edit that is new in the card is removed by Undo, tuned or not");
	assert.deepEqual(openChanges(raw, now + CARD_MS + 1000).map((c) => c.id), ["b"]);
	await clearChanges(["b"]);
	assert.deepEqual((await chrome.storage.session.get(CHANGES_KEY))[CHANGES_KEY].map((c) => c.id).includes("b"), false);
	assert.deepEqual(openChanges("x", now), []);
});

test("an agent tunes a style in place, the change is noted with what it was, and a script is never updated", async () => {
	fresh();
	const { handlers } = await import(`../src/bridge/tools.ts?ctx=${Math.random()}`);
	const ctx = { session: { groupName: "Claude" }, clientId: "c1", isGuarded: () => false, checkUrl: async () => undefined };
	const { edit } = await handlers["edits.add"](ctx, { kind: "style", host: "x.com", value: "a { color: red }", note: "Red" });
	assert.equal(edit.on, true);
	const tuned = (await handlers["edits.update"](ctx, { id: edit.id, value: "a { color: blue }" })).edit;
	assert.deepEqual([tuned.id, tuned.value, tuned.on], [edit.id, "a { color: blue !important; }", true]);
	assert.equal((await store.load()).edits.length, 1, "tuned, not stacked");
	await assert.rejects(handlers["edits.update"](ctx, { id: edit.id, value: "a { position: fixed }" }), /position/);
	assert.equal((await store.load()).edits[0].value, "a { color: blue !important; }", "a refused update changes nothing");
	await assert.rejects(handlers["edits.update"](ctx, { id: "nope", value: ".a" }), /No site edit/);
	const script = (await handlers["edits.add"](ctx, { kind: "script", host: "x.com", value: "1" })).edit;
	assert.equal(script.on, false);
	await assert.rejects(handlers["edits.update"](ctx, { id: script.id, value: "2" }), /script/i);
	const list = async () => (await chrome.storage.session.get(CHANGES_KEY))[CHANGES_KEY].map((c) => c.id);
	assert.deepEqual(await list(), [edit.id, script.id]);
	await handlers["edits.add"](ctx, { kind: "style", host: "x.com", value: "a { color: blue }" });
	assert.deepEqual(await list(), [edit.id, script.id], "saving the same edit again is no news");
	await handlers["edits.remove"](ctx, { id: edit.id });
	assert.deepEqual(await list(), [script.id]);
	// The site check runs on an update too: the edit's host may have become one this agent can't open.
	const denied = { ...ctx, checkUrl: async () => { throw new Error("Not allowed to open x.com"); } };
	const left = (await handlers["edits.add"](ctx, { kind: "hide", host: "x.com", value: ".a" })).edit;
	await assert.rejects(handlers["edits.update"](denied, { id: left.id, value: ".b" }), /Not allowed/);
});

test("an update of an edit that is off leaves it off", () => {
	const { state } = store.added(empty, { host: "x.com", kind: "hide", value: ".a", actor: "person", who: "" }, "a", 1);
	const off = store.switched(state, "a", false, "person");
	const next = store.updated(off, "a", ".b", undefined);
	assert.deepEqual([next.edits[0].value, next.edits[0].on], [".b", false]);
});

test("the ready-made switches fit the page, and each is an edit the checks pass", () => {
	assert.deepEqual(readyMadeFor("https://example.com/").map((r) => r.name), ["Dark"]);
	assert.deepEqual(readyMadeFor("https://www.youtube.com/watch").map((r) => r.name), ["Dark", "Hide Shorts", "Hide comments", "Hide related videos"]);
	assert.deepEqual(readyMadeFor("https://x.com/home").map((r) => r.name), ["Dark", "Hide the right column"]);
	for (const url of ["https://youtube.com/", "https://x.com/", "https://reddit.com/"])
		for (const ready of readyMadeFor(url)) {
			const host = ready.host ?? new URL(url).hostname;
			const { state, edit } = store.added(empty, { host, kind: ready.kind, value: ready.value, note: ready.name, actor: "person", who: "" }, "a", 1);
			assert.equal(readyMadeEdit(state, ready, host)?.id, edit.id, ready.name);
		}
});

test("a change is named by its note, else by what it does", () => {
	const e = (kind, value, note = "") => ({ id: "a", host: "x.com", kind, value, note, on: true, addedBy: "you", createdAt: 1 });
	assert.equal(changeTitle(e("hide", ".a", "Hides the bar")), "Hides the bar");
	assert.equal(changeTitle(e("hide", ".a")), "Hides .a");
	assert.equal(changeTitle(e("filter", store.checkValue("filter", JSON.stringify({ words: ["crypto"], handles: ["@spam"] })))), "Hides posts: crypto, @spam");
	assert.equal(changeTitle(e("style", store.checkValue("style", "dark"))), "Dark");
});
