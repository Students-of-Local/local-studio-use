// "Match the model" site access (docs/decisions.md, D60), now part of Auto (D67): Auto is the default, what it decides
// for each tier, and that Manual and Yolo mean what "ask" and "allow_all" did.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	allowHost,
	asModelTier,
	getPermissionMode,
	isUrlAllowed,
	opensAnySite,
	setPermissionMode,
} from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const SITE = "https://example.com/page";

function fresh() {
	installFakeChrome();
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
}

test("nothing stored is auto; a set mode is kept", async () => {
	fresh();
	assert.equal(await getPermissionMode(), "auto");
	await chrome.storage.local.set({ permission_mode: "something-else" });
	assert.equal(await getPermissionMode(), "auto");
	for (const mode of ["manual", "yolo", "auto"]) {
		await setPermissionMode(mode);
		assert.equal(await getPermissionMode(), mode);
	}
});

test("auto: a frontier model opens any site; small, unknown and silent clients need the site allowed", async () => {
	fresh();
	assert.equal(await isUrlAllowed(SITE, "frontier"), true);
	assert.equal(await isUrlAllowed(SITE, "small"), false);
	assert.equal(await isUrlAllowed(SITE, "unknown"), false);
	assert.equal(await isUrlAllowed(SITE), false, "an older CLI sends no tier");
	await allowHost("example.com");
	assert.equal(await isUrlAllowed(SITE, "small"), true, "an allowed site opens for every tier");
	assert.equal(await isUrlAllowed(SITE, "unknown"), true);
	assert.equal(opensAnySite("auto", "frontier"), true);
	assert.equal(opensAnySite("auto", "small"), false);
	assert.equal(opensAnySite("auto", "unknown"), false);
	assert.equal(opensAnySite("auto", undefined), false);
});

test("manual asks a frontier client, and yolo opens for an unknown one", async () => {
	fresh();
	await setPermissionMode("manual");
	assert.equal(await isUrlAllowed(SITE, "frontier"), false);
	assert.equal(opensAnySite("manual", "frontier"), false);
	await setPermissionMode("yolo");
	assert.equal(await isUrlAllowed(SITE, "unknown"), true);
	assert.equal(opensAnySite("yolo", "small"), true);
});

test("auto never opens the extension's own pages, even for a frontier model", async () => {
	fresh();
	const own = `chrome-extension://${chrome.runtime.id}/sidepanel.html`;
	assert.equal(await isUrlAllowed(own, "frontier"), false);
	assert.equal(await isUrlAllowed(`blob:chrome-extension://${chrome.runtime.id}/6f1c0c3e`, "frontier"), false);
});

test("a hello's tier is trusted only as frontier or small; anything else is unknown", () => {
	assert.equal(asModelTier("frontier"), "frontier");
	assert.equal(asModelTier("small"), "small");
	for (const v of [undefined, null, "", "FRONTIER", "allow_all", 1, {}]) assert.equal(asModelTier(v), "unknown", String(v));
});

test("the bridge checks each site against the calling client's tier, and guarded hosts before that", () => {
	const native = read("src/bridge/native.ts");
	assert.match(native, /tier: asModelTier\(msg\.client\.tier\)/, "the hello's tier is kept for the client");
	assert.match(native, /async function askPermission\([^)]*\): Promise<boolean> \{\s*if \(isOwnExtensionUrl\(url\)\) return false;\s*if \(await isUrlAllowed\(url, state\.tier, state\.remote\)\) return true;/);
	assert.match(native, /if \(isGuardedUrl\(url, req\.guardedHosts\)\) throw guardedError\(url\);\s*if \(!\(await askPermission\(state, url\)\)\)/);
	assert.match(native, /isUrlAllowed\(url, state\.tier, state\.remote\)\),\s*askUpload/, "frames use the client's tier");
	assert.match(read("src/bridge/files.ts"), /isUrlAllowed\(url, ctx\.tier, ctx\.remote\)/, "an upload's page uses the client's tier");
	// The upload question is asked in every mode: askUpload never reads the permission mode.
	const askUpload = native.slice(native.indexOf("async function askUpload("), native.indexOf("async function askUpload(") + 1500);
	assert.doesNotMatch(askUpload, /getPermissionMode|isUrlAllowed|opensAnySite/);
});

test("Settings > Agents offers Manual, Auto and Yolo, and Auto is the default", () => {
	const tab = read("src/dialogs/BridgeTab.ts");
	assert.match(tab, /@state\(\) private mode: PermissionMode = "auto";/);
	const modes = [...tab.matchAll(/\{\s*mode: "([a-z]+)",\s*title: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
	assert.deepEqual(modes, [["manual", "Manual"], ["auto", "Auto (default)"], ["yolo", "Yolo"]]);
	assert.match(tab, /agents on frontier models open ordinary sites; small or unknown models ask first\. Every agent asks before it goes straight to mail, a bank or another sensitive site you haven't allowed \(a link it clicks there isn't checked\)/);
});
