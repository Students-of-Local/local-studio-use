// Links that do something on this computer (src/links): the grammar, what a button says, who may run one, and what an agent
// may open by itself. The host's half is cli/test/open-link.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const { linkLabel, linkText, linkTitle, parseLink, parsePlace } = await import("../src/links/parse.ts");
const { offerButtons, onOpen, openPlace, startLinks } = await import("../src/links/worker.ts");
const { LINKS_PORT, OFFERS_KEY, OPEN_PLACE, SHOW_SETTINGS_KEY } = await import("../src/links/types.ts");

const GOOD = [
	["localstudio://settings/Skills", { kind: "settings", section: "skills" }, "Open Local Studio settings: Skills"],
	["localstudio://browser/extensions", { kind: "browser", page: "extensions" }, "Open the browser's extensions"],
	["localstudio://system/displays", { kind: "system", pane: "displays" }, "Open Displays in System Settings"],
	["localstudio://app/Visual%20Studio%20Code", { kind: "app", name: "Visual Studio Code" }, "Open Visual Studio Code"],
	["localstudio://reveal?path=/Users/d/My%20report.pdf", { kind: "reveal", path: "/Users/d/My report.pdf" }, "Show My report.pdf in Finder"],
	["localstudio://file?path=~/a.pdf", { kind: "file", path: "~/a.pdf" }, "Open a.pdf"],
	["localstudio://file?path=C:%5Cdocs%5Ca.pdf", { kind: "file", path: "C:\\docs\\a.pdf" }, "Open a.pdf"],
	["localstudio://shortcut/Focus", { kind: "shortcut", name: "Focus" }, "Run the shortcut “Focus”"],
	["LocalStudio://SYSTEM/Wifi", { kind: "system", pane: "wifi" }, "Open Wi-Fi in System Settings"],
];
const BAD = [
	"", "localstudio:", "localstudio://", "localstudio://app", "localstudio://app/", "localstudio://app/../x", "localstudio://app/a/b",
	"localstudio://app/-a", "localstudio://app/.a", "localstudio://app/%2e%2e", "localstudio://app/a%2Fb", "localstudio://app/a%5Cb",
	"localstudio://app/a%00b", "localstudio://app/a%0Ab", "localstudio://app/a%E2%80%AEb", "localstudio://app/%E0%A4%A", "localstudio://app/x#y",
	"localstudio://app/x?path=/a", `localstudio://app/${"a".repeat(101)}`, "localstudio://app/%20x", "localstudio://app/C%3Ax",
	"localstudio://file?path=a", "localstudio://file?path=/a/../b", "localstudio://file?path=/a%2F..%2Fb", "localstudio://file?path=//server/share",
	"localstudio://file?path=%5C%5Cserver%5Cshare", "localstudio://file?path=/a&x=1", "localstudio://file?x=1&path=/a", "localstudio://file?path=",
	`localstudio://file?path=/${"a".repeat(1024)}`, "localstudio://file/a", "localstudio://reveal/a", "localstudio://thread/abc",
	"localstudio://settings/Nope", "localstudio://settings/__proto__", "localstudio://system/constructor", "localstudio://user@app/x",
	"localstudio://app:1/x", "localstudio-nightly://app/x", "http://app/x", "javascript:alert(1)", " localstudio://app/x", "localstudio://app/x ", 7, null,
];

test("each form is read as its kind and value, and says its own words", () => {
	for (const [text, link, label] of GOOD) {
		assert.deepEqual(parseLink(text), link, text);
		assert.equal(linkLabel(link, "mac"), label);
		assert.deepEqual(parseLink(linkText(link)), link, "written back, it is the same link");
	}
	assert.equal(linkLabel({ kind: "reveal", path: "/a/b.txt" }, "win"), "Show b.txt in Explorer");
	assert.equal(linkTitle({ kind: "file", path: "/a/b.txt" }), "/a/b.txt", "the whole path is in the tooltip");
	assert.equal(linkLabel({ kind: "app", name: "x".repeat(60) }, "mac").length, 53);
});

test("anything that isn't exactly a link is not one", () => {
	for (const text of BAD) assert.equal(parseLink(text), undefined, String(text));
});

test("an agent opens only places by itself", () => {
	assert.deepEqual(parsePlace("settings/Skills"), { kind: "settings", section: "skills" });
	assert.deepEqual(parsePlace("system/sound"), { kind: "system", pane: "sound" });
	for (const place of ["app/Terminal", "shortcut/Focus", "file?path=/a.pdf", "localstudio://system/sound", "", 4]) assert.equal(parsePlace(place), undefined);
});

function world({ panel = true, host = (m) => ({ type: "open", id: m.id, result: { done: "Opened." } }) } = {}) {
	installFakeChrome();
	const { chrome } = globalThis;
	const sent = [];
	const tabs = [];
	const badges = [];
	let connect;
	let message;
	chrome.runtime.getURL = () => "chrome-extension://id/";
	chrome.runtime.getContexts = async () => (panel ? [{}] : []);
	chrome.runtime.onConnect = { addListener: (f) => (connect = f) };
	chrome.runtime.onMessage = { addListener: (f) => (message = f) };
	chrome.tabs = { ...chrome.tabs, create: async (o) => tabs.push(o.url) };
	chrome.action = { setBadgeText: async ({ text }) => badges.push(text), setBadgeBackgroundColor: async () => {}, setTitle: async () => {} };
	startLinks((m) => {
		sent.push(m.link);
		if (!host) return false;
		queueMicrotask(() => onOpen(host(m)));
		return true;
	});
	const port = (sender) => {
		const replies = [];
		let listener;
		let open = true;
		connect({ name: LINKS_PORT, sender, postMessage: (m) => replies.push(m), disconnect: () => (open = false), onMessage: { addListener: (f) => (listener = f) } });
		return { replies, isOpen: () => open, say: async (m) => (listener?.(m), await new Promise((r) => setTimeout(r, 5)), replies.at(-1)) };
	};
	return { chrome, sent, tabs, badges, port, message: (...a) => message(...a) };
}
const PANEL = { url: "chrome-extension://id/sidepanel.html", origin: "chrome-extension://id" };
let token = 0;
const now = () => ({ token: `t${++token}`, at: Date.now() });

test("a click in the side panel runs a link; a page, a tab, an old or used token runs nothing", async () => {
	const w = world();
	for (const sender of [{ ...PANEL, tab: { id: 1 } }, { url: "https://evil.example/", origin: "https://evil.example" }, { ...PANEL, url: "chrome-extension://id/sign-in.html" }, undefined])
		assert.equal(w.port(sender).isOpen(), false);
	const panel = w.port(PANEL);
	assert.deepEqual(await panel.say({ id: 1, link: "localstudio://app/Calculator", gesture: now() }), { id: 1, done: "Opened." });
	assert.deepEqual(w.sent, ["localstudio://app/Calculator"]);
	const used = now();
	await panel.say({ id: 2, link: "localstudio://app/Calculator", gesture: used });
	for (const gesture of [undefined, used, { token: "old", at: Date.now() - 60_000 }, { token: 5, at: Date.now() }])
		assert.equal((await panel.say({ id: 3, link: "localstudio://app/Calculator", gesture })).error.code, "no_gesture");
	assert.equal(w.sent.length, 2);
	assert.equal((await panel.say({ id: 4, link: "localstudio://app/../x", gesture: now() })).error.code, "bad_params");
	assert.deepEqual(await panel.say({ id: 5, link: "localstudio://browser/downloads", gesture: now() }), { id: 5, done: "Opened the browser's downloads." });
	assert.deepEqual(w.tabs, ["chrome://downloads/"]);
	assert.equal(w.sent.length, 2, "the browser's own pages never reach the host");
});

test("a host that refuses, is gone or goes away is said in words", async () => {
	const refuses = world({ host: (m) => ({ type: "open", id: m.id, error: { code: "not_found", message: "There is no app called X." } }) });
	assert.equal((await refuses.port(PANEL).say({ id: 1, link: "localstudio://app/X", gesture: now() })).error.message, "There is no app called X.");
	const none = world({ host: null });
	assert.match((await none.port(PANEL).say({ id: 1, link: "localstudio://app/X", gesture: now() })).error.message, /isn't running/);
	const gone = world({ host: () => "disconnected" });
	assert.match((await gone.port(PANEL).say({ id: 1, link: "localstudio://app/X", gesture: now() })).error.message, /went away/);
});

test("open_settings shows a section at once, or behind a badge while the panel is closed", async () => {
	const open = world();
	assert.deepEqual(await openPlace({ clientId: "a1", name: "Claude Code" }, "settings/skills"), { done: "Local Studio's settings now show Skills." });
	const shown = (await open.chrome.storage.session.get(SHOW_SETTINGS_KEY))[SHOW_SETTINGS_KEY];
	assert.equal(shown.section, "Skills");
	assert.equal(open.badges.at(-1), undefined);
	const closed = world({ panel: false });
	assert.match((await openPlace({ clientId: "a2", name: "Claude Code" }, "settings/Skills")).done, /side panel is closed/);
	assert.equal(closed.badges.at(-1), "1");
	closed.port(PANEL);
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(closed.badges.at(-1), "", "the badge goes when the panel opens");
	assert.deepEqual(await openPlace({ clientId: "a3", name: "X" }, "system/displays"), { done: "Opened." });
	assert.deepEqual(closed.sent, ["localstudio://system/displays"]);
	assert.equal((await openPlace({ clientId: "a3", name: "X" }, "app/Terminal")).error.code, "bad_params");
});

test("one agent opens at most six places a minute, and another is not held up by it", async () => {
	world();
	for (let i = 0; i < 6; i++) assert.ok((await openPlace({ clientId: "fast", name: "X" }, "browser/history")).done);
	assert.equal((await openPlace({ clientId: "fast", name: "X" }, "browser/history")).error.code, "permission_denied");
	assert.ok((await openPlace({ clientId: "other", name: "X" }, "browser/history")).done);
});

test("offer_buttons: one card an agent, checked whole, opened by nobody but the person", async () => {
	const w = world();
	const client = { clientId: "c1", name: "Claude Code" };
	const cards = async () => (await w.chrome.storage.session.get(OFFERS_KEY))[OFFERS_KEY] ?? [];
	const app = "localstudio://app/Calculator";
	for (const params of [{}, { links: [] }, { links: [app, app, app, app, app] }, { links: ["https://a.example"] }, { links: [app], note: "x".repeat(201) }, { links: [app], note: 5 }, { links: app }, { links: [app], label: "Harmless" }])
		assert.equal((await offerButtons(client, params)).error.code, "bad_params", JSON.stringify(params).slice(0, 60));
	assert.deepEqual(await cards(), []);
	assert.deepEqual(await offerButtons(client, { links: [app], note: "Try it" }), { done: "Shown." });
	assert.deepEqual(await offerButtons(client, { links: ["LOCALSTUDIO://system/Sound"] }), { done: "Shown." });
	const list = await cards();
	assert.equal(list.length, 1, "the newer card replaces it");
	assert.deepEqual(list[0].links, ["localstudio://system/sound"]);
	assert.deepEqual(w.sent, [], "offering opens nothing");
});

test("the panel's own agent opens a place through an extension page only", async () => {
	const w = world();
	const ask = (sender) => new Promise((resolve) => w.message({ type: OPEN_PLACE, place: "browser/about" }, sender, resolve) === true || resolve("ignored"));
	assert.equal(await ask({ url: "https://evil.example/", tab: { id: 1 } }), "ignored");
	assert.deepEqual(await ask(PANEL), { done: "Opened the browser's About page." });
});
