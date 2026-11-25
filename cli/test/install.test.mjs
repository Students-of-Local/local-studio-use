// Runs the built CLI against a throwaway HOME: install writes the native host manifest
// into every browser directory present, and the manifest's origin matches the id the
// extension key in static/manifest.chrome.json produces.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "local-studio-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

const base =
	process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
const browsers = {
	Helium: join(base, "net.imput.helium"),
	Chrome: process.platform === "darwin" ? join(base, "Google", "Chrome") : join(base, "google-chrome"),
};
const absent = process.platform === "darwin" ? join(base, "Microsoft Edge") : join(base, "microsoft-edge");

// A private, empty socket directory: `status` must never reach the user's running browser.
const socketDir = join(home, "sock");
mkdirSync(socketDir, { mode: 0o700 });

function run(...args) {
	const env = { ...process.env, HOME: home, LOCAL_STUDIO_BROWSER_SOCKET_DIR: socketDir };
	delete env.XDG_CONFIG_HOME;
	try {
		return execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
	} catch (err) {
		// `status` exits 1 when no bridge socket is up; its stdout is what we check.
		return err.stdout;
	}
}

function extensionIdFromKey() {
	const manifest = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8"));
	const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

test("install registers com.localstudio.browser for Helium and Chrome, skips absent browsers", () => {
	for (const dir of Object.values(browsers)) mkdirSync(dir, { recursive: true });
	run("install");
	const id = extensionIdFromKey();
	for (const dir of Object.values(browsers)) {
		const host = JSON.parse(readFileSync(join(dir, "NativeMessagingHosts", "com.localstudio.browser.json"), "utf8"));
		assert.equal(host.name, "com.localstudio.browser");
		assert.deepEqual(host.allowed_origins, [`chrome-extension://${id}/`]);
		assert.equal(host.path, join(home, ".local-studio", "browser", "local-studio-browser-host"));
		assert.deepEqual(readdirSync(join(dir, "NativeMessagingHosts")), ["com.localstudio.browser.json"], "and no other name");
	}
	assert.equal(existsSync(absent), false);
});

test("status reports each browser's host state", () => {
	const report = JSON.parse(run("status", "--json"));
	assert.equal(report.connected, false);
	const state = Object.fromEntries(report.hosts.map((h) => [h.browser, h.state]));
	assert.equal(state.Helium, "current");
	assert.equal(state.Chrome, "current");
	assert.match(run("status"), /Helium\s+host registered/);
});

test("status lists a running browser only when a profile has the extension on, so update waits only for one that can connect", () => {
	// first-F1 of the review of PR 285: Chrome runs (this process holds its lock) and install wrote its host manifest,
	// but the extension isn't in it, so it is not listed. Helium runs with the extension in Default.
	const id = extensionIdFromKey();
	const prefs = (dir, settings) => {
		mkdirSync(join(dir, "Default"), { recursive: true });
		writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ extensions: { settings } }));
	};
	const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
	for (const dir of Object.values(browsers)) symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
	const running = () => JSON.parse(run("status", "--json")).running;
	try {
		assert.deepEqual(running(), [], "a live lock and a host manifest, with no extension in any profile");
		prefs(browsers.Helium, { [id]: { location: 4 } });
		prefs(browsers.Chrome, { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {} });
		assert.deepEqual(running(), ["Helium"]);
		// Turned off in Helium: not listed. A lock from a process that is gone: not running.
		prefs(browsers.Helium, { [id]: { location: 4, disable_reasons: [1] } });
		assert.deepEqual(running(), []);
		prefs(browsers.Helium, { [id]: { location: 4 } });
		rmSync(join(browsers.Helium, "SingletonLock"));
		symlinkSync(`${hostname()}-${gone}`, join(browsers.Helium, "SingletonLock"));
		assert.deepEqual(running(), []);
	} finally {
		for (const dir of Object.values(browsers)) {
			rmSync(join(dir, "SingletonLock"), { force: true });
			rmSync(join(dir, "Default"), { recursive: true, force: true });
		}
	}
});

const manifestOf = (dir) => join(dir, "NativeMessagingHosts", "com.localstudio.browser.json");
const usage = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home, LOCAL_STUDIO_BROWSER_SOCKET_DIR: socketDir }, encoding: "utf8" });

test("status --json names the program each manifest runs, and null where there is none", () => {
	const file = manifestOf(browsers.Chrome);
	const ours = readFileSync(file, "utf8");
	const program = () => Object.fromEntries(JSON.parse(run("status", "--json")).hosts.map((h) => [h.browser, h.program]));
	try {
		writeFileSync(file, JSON.stringify({ ...JSON.parse(ours), path: "/opt/other/helper" }));
		assert.equal(program().Chrome, "/opt/other/helper");
		assert.equal(program().Helium, join(home, ".local-studio", "browser", "local-studio-browser-host"));
		rmSync(file);
		assert.equal(program().Chrome, null);
	} finally {
		writeFileSync(file, ours);
	}
});

test("install --remove takes out only this program's manifests; --browser names one and --dry-run none", () => {
	run("install");
	const theirs = JSON.stringify({ name: "com.localstudio.browser", path: "/opt/other/helper", allowed_origins: ["chrome-extension://aaaa/"] });
	assert.match(run("install", "--remove", "--dry-run"), /Would remove .*\n.*Would remove/);
	assert.ok(existsSync(manifestOf(browsers.Helium)) && existsSync(manifestOf(browsers.Chrome)), "a dry run removes nothing");

	run("install", "--remove", "--browser", "Helium");
	assert.equal(existsSync(manifestOf(browsers.Helium)), false);
	assert.ok(existsSync(manifestOf(browsers.Chrome)), "the other browser keeps its registration");

	run("install");
	writeFileSync(manifestOf(browsers.Chrome), theirs);
	assert.match(run("install", "--remove"), /Left alone .*it runs \/opt\/other\/helper/);
	assert.equal(existsSync(manifestOf(browsers.Helium)), false);
	assert.equal(readFileSync(manifestOf(browsers.Chrome), "utf8"), theirs, "byte for byte");

	// A script that starts another program, and a program that is gone, aren't ours either.
	const script = join(home, "theirs.sh");
	writeFileSync(script, '#!/bin/sh\nexec "/opt/other/helper" "$@"\n', { mode: 0o755 });
	for (const path of [script, "/gone/local-studio-browser", undefined]) {
		const text = JSON.stringify({ name: "com.localstudio.browser", path });
		writeFileSync(manifestOf(browsers.Chrome), text);
		run("install", "--remove");
		assert.equal(readFileSync(manifestOf(browsers.Chrome), "utf8"), text);
	}
	rmSync(manifestOf(browsers.Chrome));
	assert.match(run("install", "--remove"), /Nothing is registered/);
});

test("install --remove refuses install flags, a value and a browser it doesn't know", () => {
	for (const args of [["--force"], ["--local-studio"], ["--release", "/x"], ["--restart-services"]]) {
		const r = usage("install", "--remove", ...args);
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stderr, /--remove only removes registrations/);
	}
	assert.equal(usage("install", "--remove", "Helium").status, 2, "the browser is --browser's");
	assert.equal(usage("install", "--remove=Helium").status, 2);
	assert.equal(usage("install", "--remove", "--browser", "Netscape").status, 2);
});
