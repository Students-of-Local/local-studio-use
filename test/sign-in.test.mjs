// The sign-in a user types for an agent (src/handback/sign-in.ts): which fields may be asked for, which pages, and who may
// answer. The whole path, window and page, runs in cli/test/e2e-panel.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { fromSignInWindow, signInEnd, signInFields, signInOrigin, signInValues } from "../src/handback/sign-in.ts";
import { handbackOutcome } from "../src/handback/state.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

test("the fields are refs of the top page, and no refusal repeats what was passed", () => {
	assert.deepEqual(signInFields({ username: "e1", password: "@E2 " }), { fields: { username: "e1", password: "e2" } });
	assert.deepEqual(signInFields({ password: "e2" }), { fields: { password: "e2" } });
	assert.deepEqual(signInFields({ username: "e1", password: "" }), { fields: { username: "e1" } });
	for (const bad of [undefined, {}, { username: "e1", password: "e1" }, { password: "hunter2" }, { username: 5 }]) {
		const { error } = signInFields(bad);
		assert.ok(error, JSON.stringify(bad));
		assert.ok(!error.includes("hunter2"), error);
	}
	assert.match(signInFields({ password: "f1a2be12" }).error, /frame from another site/);
});

test("a sign-in goes to https, or to this computer", () => {
	for (const ok of ["https://github.com", "http://localhost:3000", "http://127.0.0.1:80", "http://[::1]:8080", "http://a.localhost"])
		assert.equal(signInOrigin(ok), true, ok);
	for (const no of ["http://github.com", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "file://", "null", ""])
		assert.equal(signInOrigin(no), false, no);
});

test("only the extension's own sign-in window answers", () => {
	const url = "chrome-extension://abc/sign-in.html";
	globalThis.chrome = { runtime: { id: "abc", getURL: (p) => `chrome-extension://abc/${p}` } };
	try {
		assert.equal(fromSignInWindow({ id: "abc", url: `${url}#1` }), true);
		for (const s of [
			{ id: "abc" },
			{ id: "other", url },
			{ id: "abc", url: "https://evil.test/sign-in.html" },
			{ id: "abc", url: "chrome-extension://abc/sidepanel.html" },
			{ id: "abc", url: "chrome-extension://abc/sign-in.html.evil" },
		])
			assert.equal(fromSignInWindow(s), false, JSON.stringify(s));
	} finally {
		delete globalThis.chrome;
	}
});

test("the answer holds the asked fields and nothing else", () => {
	const say = (values) => ({ type: "local-studio-sign-in", id: "1", action: "fill", values });
	assert.deepEqual(signInValues(say({ username: "pat", password: "pw", extra: "x" }), { password: "e2" }), { password: "pw" });
	for (const values of [undefined, {}, { password: "" }, { password: 5 }])
		assert.equal(signInValues(say(values), { password: "e2" }), undefined);
});

test("'Nothing was entered' is said only when the page code said so", () => {
	assert.deepEqual(signInEnd({ wrote: ["username", "password"] }, "Claude"), {});
	const none = signInEnd({ wrote: [], why: "The page moved to another site." }, "Claude");
	assert.equal(none.why, "The page moved to another site. Nothing was entered.");
	assert.match(none.error, /so nothing was entered/);
	const some = signInEnd({ wrote: ["username"], why: "Ref e2 is not a password field." }, "Claude");
	assert.match(some.why, /Only the username was entered\.$/);
	assert.match(some.error, /only your username was entered/);
	const lost = signInEnd(undefined, "Claude");
	assert.match(lost.why, /it isn't known what went in/);
	assert.ok(!/othing was entered/.test(lost.why + lost.error));
});

test("what the agent reads says nothing of what was typed", () => {
	assert.match(handbackOutcome("signed_in", 7, "Sign in").text, /You were not given it: never read the fields back/);
	assert.match(handbackOutcome("declined", 7, "Sign in").text, /chose not to type a sign-in on tab 7/);
	assert.match(handbackOutcome("failed", 7, "Sign in", 600_000, "The page moved.").text, /tab 7: The page moved\. read_page/);
});

test("a page the tab moved to gets none of a sign-in, whatever it put where the page library or a getter would run", async () => {
	installFakeChrome();
	const { writeSignIn } = await import("../src/browser/page.ts");
	const tabId = (await chrome.tabs.create({ url: "https://evil.test/" })).id;
	const page = vm.createContext({ location: { origin: "https://evil.test" } });
	// The page's traps: the library's global answers any key, and a getter reads the text of the code around it.
	vm.runInContext(
		`const seen = [];
		const see = (args) => (seen.push(JSON.stringify([...args])), { wrote: ["password"] });
		globalThis.__localStudioLib = new Proxy({}, { get: () => (...args) => see(args) });
		Object.defineProperty(Object.prototype, "then", { get: function then() { try { seen.push(String(then.caller)); } catch {} } });
		globalThis.Error = function (why) { seen.push(String(Error.caller)); return { message: why }; };`,
		page,
	);
	chrome.debugger.sendCommand = async (_target, method, params) =>
		method === "Runtime.evaluate" ? { result: { value: await vm.runInContext(params.expression, page) } } : {};
	const refused = { configureWorld: async () => {}, execute: async () => Promise.reject(new Error("the 'Allow User Scripts' toggle is off")) };
	for (const api of [undefined, refused]) {
		chrome.userScripts = api;
		const done = await writeSignIn(tabId, { password: "e2" }, "https://a.test", { password: "hunter2" });
		assert.equal(done.why, "The page moved to another site.");
		assert.equal(done.wrote.length, 0);
		assert.doesNotMatch(vm.runInContext("seen.join()", page), /hunter2/, api ? "userScripts refused" : "no userScripts");
	}
});
