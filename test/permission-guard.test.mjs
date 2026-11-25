// What each permission mode lets an agent do (docs/decisions.md, D67), beyond the store and its migration
// (permission-modes.test.mjs): a remote session is never in Yolo, and every step in the Runs log carries its mode. The
// bridge itself is driven in dialog-preset.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { entersText, textLimit } from "../src/bridge/risk-rules.ts";
import { allowHost, getPermissionMode, isRemoteClient, isUrlAllowed, LEGACY_MODE_KEY, MODE_KEY, modeFor, peekPermissionMode, recordDecision, setPermissionMode } from "../src/bridge/permissions.ts";
import { addStep } from "../src/runs/log.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");

function fresh() {
	installFakeChrome();
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
}

test("a remote session is never in Yolo: it gets Auto's rule", async () => {
	fresh();
	assert.deepEqual(
		["manual", "auto", "yolo"].map((m) => [modeFor(m, false), modeFor(m, true)]),
		[["manual", "manual"], ["auto", "auto"], ["yolo", "auto"]],
	);
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", false), true);
	assert.equal(await isUrlAllowed("https://news.example.com/", "unknown", true), false, "remote, unknown model: asks");
	assert.equal(await isUrlAllowed("https://news.example.com/", "frontier", true), true, "remote, frontier: Auto's rule");
});

test("Auto: a frontier model opens an ordinary site, but mail, a bank or a password manager asks until allowed", async () => {
	fresh();
	await setPermissionMode("auto");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), true);
	for (const tier of ["frontier", "unknown"]) assert.equal(await isUrlAllowed("about:blank", tier), true);
	const sensitive = ["https://mail.google.com/mail/u/0", "https://www.chase.com/", "https://vault.bitwarden.com/", "https://console.aws.amazon.com/", "https://github.com/settings/profile", "view-source:https://mail.google.com/", "blob:https://mail.google.com/1", "view-source:blob:https://mail.google.com/1"];
	for (const url of sensitive) assert.equal(await isUrlAllowed(url, "frontier"), false, url);
	await allowHost("chase.com");
	assert.equal(await isUrlAllowed("https://secure.chase.com/web/auth", "frontier"), true, "the person allowed it");
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed("https://mail.google.com/mail/u/0", "unknown"), true, "Yolo asks nothing");
	assert.equal(await isUrlAllowed("https://mail.google.com/mail/u/0", "frontier", true), false, "but a remote session in Yolo has Auto's asks");
	await setPermissionMode("manual");
	assert.equal(await isUrlAllowed("https://news.example.com/today", "frontier"), false);
});

test("a frontier model's sensitive site is put to the person, and a no says how to allow it", async () => {
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
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "sensitive", tier: "frontier" } });
	const sent = async (is) => {
		for (let i = 0; i < 400; i++) {
			const found = port.sent.find(is);
			if (found) return found;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error("never sent");
	};
	port.deliver({ type: "request", clientId: "c1", id: 2, method: "tabs.create", params: { url: "https://mail.google.com/mail/" } });
	const asked = await sent((m) => m.event === "permission_request");
	assert.equal(asked.data.host, "mail.google.com");
	await recordDecision(asked.data.requestId, "deny");
	const refused = await sent((m) => m.type === "response" && m.id === 2);
	assert.equal(refused.error?.code, "permission_denied");
	assert.match(refused.error.message, /Not allowed to open mail\.google\.com\. The user can allow it in the Local Studio side panel/);
});

test("an older CLI says nothing about remote, but its remote sessions are told by the name serve gives them", () => {
	for (const [client, remote] of [
		[{ name: "claude", remote: true }, true],
		[{ name: "remote-web" }, true],
		[{ name: "claude" }, false],
		[{ name: "claude", remote: "yes" }, false],
		[{ name: "my-remote-agent" }, false],
		[{}, false],
	])
		assert.equal(isRemoteClient(client), remote, JSON.stringify(client));
	// The name this rests on.
	assert.match(read("cli/src/remote.ts"), /name: `remote-\$\{label\}`,/);
});

test("peeking at the mode migrates nothing: the Runs log reads it on every step", async () => {
	fresh();
	await chrome.storage.local.set({ [LEGACY_MODE_KEY]: "allow_all" });
	assert.equal(await peekPermissionMode(), "yolo");
	assert.equal((await chrome.storage.local.get(MODE_KEY))[MODE_KEY], undefined, "nothing written");
	// getPermissionMode migrates a legacy name kept under the current key like no mode at all.
	await chrome.storage.local.remove(LEGACY_MODE_KEY);
	await chrome.storage.local.set({ [MODE_KEY]: "allow_all" });
	const peeked = await peekPermissionMode();
	assert.equal(peeked, await getPermissionMode());
	assert.equal(peeked, "auto");
	await setPermissionMode("manual");
	assert.equal(await peekPermissionMode(), "manual");
});

test("every step in the Runs log carries the mode it ran under", () => {
	const log = addStep({ runs: [] }, "s1", { who: "claude", tool: "click", params: { ref: "e3" }, ok: true, ms: 12, mode: "yolo" }, 1);
	assert.equal(log.runs[0].steps[0].mode, "yolo");
	const native = read("src/bridge/native.ts");
	assert.match(native, /if \(isRunStep\(req\.method\)\) runMode = modeFor\(await peekPermissionMode\(\), state\.remote\);/);
	assert.match(native, /\.\.\.\(runMode \? \{ mode: runMode \} : \{\}\),/);
});

test("the presses that enter text: one character or Space, read as pressKey reads the chord", () => {
	for (const [tool, key, want] of [
		["fill", undefined, true],
		["type", undefined, true],
		["press", "a", true],
		["press", " a ", true],
		["press", "+a", true],
		["press", "Hyper+a", true],
		["press", "Shift+A", true],
		["press", "Space", true],
		["press", "\u{1F600}", true],
		["press", "Enter", false],
		["press", "Tab", false],
		["press", "Control+V", true],
		["press", "Meta+Shift+v", true],
		["press", "Shift+Insert", true],
		["press", "Alt+q", true],
		["press", "Insert", false],
		["press", "Meta+a", false],
		["press", "Shift+ctrl+a", false],
		["press", undefined, false],
		["click", undefined, false],
	])
		assert.equal(entersText(tool, key), want, `${tool} ${key ?? ""}`);
	assert.doesNotMatch(read("src/bridge/panel-calls.ts"), /hardLimits/, "the side panel's agent is the person's own");
	assert.match(read("src/bridge/native.ts"), /hardLimits: true,/);
});

test("the hard limit's rule runs in the page as it stands: it names nothing outside itself", () => {
	const rule = new Function(`return (${textLimit.toString()})`)();
	for (const [t, want] of [
		[{ inputType: "password" }, "password-field"],
		[{ inputType: "text", name: "Passphrase" }, "password-field"],
		[{ inputType: "text", name: "Number", autocomplete: "cc-number" }, "payment-field"],
		[{ inputType: "text", field: "card number" }, "payment-field"],
		[{ role: "textbox", frameUrl: "https://js.stripe.com/v3/elements-inner-card.html" }, "payment-field"],
		[{ role: "textbox", frameUrl: "https://js.stripe.com.example.net/" }, undefined],
		[{ role: "textbox", frameUrl: "https://js.stripe.com./v3/" }, "payment-field"],
		[{ inputType: "text", name: "Password *" }, "password-field"],
		[{ inputType: "text", field: "password reset password" }, "password-field"],
		[{ inputType: "email", field: "password reset email" }, undefined],
		[{ inputType: "email", name: "Enter your email to reset your password" }, undefined],
		[{ inputType: "text", name: "Enter your email to reset your password" }, undefined],
		[{ inputType: "text", name: "Password reset code" }, undefined],
		[{ inputType: "number", field: "password length" }, undefined],
		[{ role: "searchbox", name: "Search passwords" }, undefined],
		[{ inputType: "text", name: "Your name" }, undefined],
		[{}, undefined],
	])
		assert.equal(rule(t), want, JSON.stringify(t));
});
