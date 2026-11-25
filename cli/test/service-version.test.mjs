// Which version a Local Studio service runs, read on any computer: a stand-in replaces launchctl, lsof and ps, so nothing here
// starts or restarts a service. The release layout is real folders and a real `release` symlink.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const mod = await loadTs(`
export { restartStaleServices, staleServices } from "@src/service-version.ts";
export * as service from "@src/service.ts";
`);
const { staleServices, restartStaleServices } = mod;
const { setServiceSeamForTests, SERVE_SERVICE, plistText, unitText } = mod.service;

const dir = mkdtempSync(join(tmpdir(), "local-studio-svcver-"));
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setServiceSeamForTests({}));

const OLD = "1.0.0-aaaaaaaaaaaa";
const NEW = "2.0.0-bbbbbbbbbbbb";

/** A release base whose pointer already names NEW, as after install moved it, and a Mac HOME with serve's plist. */
function layout(name) {
	const home = join(dir, name);
	const base = join(home, ".local", "share", "local-studio-browser");
	for (const v of [OLD, NEW]) {
		mkdirSync(join(base, "versions", v), { recursive: true });
		writeFileSync(join(base, "versions", v, "local-studio-browser"), "");
	}
	symlinkSync(join("versions", NEW), join(base, "release"));
	mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(join(home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`), "<plist/>");
	return { home, base, root: join(base, "release"), current: join(base, "versions", NEW), old: join(base, "versions", OLD) };
}

/** launchctl names pid 4242; lsof and ps answer as given (undefined: the command fails). */
function macSeam({ lsof, ps }) {
	const calls = [];
	const exec = (cmd, args) => {
		calls.push([cmd, ...args]);
		if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: "\tstate = running\n\tpid = 4242\n" } : { code: 113, out: "" };
		if (cmd === "/usr/sbin/lsof") return lsof ? { code: 0, out: `p4242\nn${lsof}\n` } : { code: 1, out: "" };
		if (cmd === "/bin/ps") return ps ? { code: 0, out: `${ps}\n` } : { code: 1, out: "" };
		return { code: 0, out: "" };
	};
	setServiceSeamForTests({ platform: "darwin", exec });
	return calls;
}

function withHome(home, fn) {
	const was = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		process.env.HOME = was;
	}
}

test("on a Mac, a serve that ps names by the release pointer but lsof shows in the old version folder is stale", () => {
	const l = layout("mac-lsof");
	macSeam({ ps: join(l.root, "local-studio-browser"), lsof: join(l.old, "local-studio-browser") });
	const stale = withHome(l.home, () => staleServices(l.current, { root: l.root }));
	assert.deepEqual(
		stale.map((s) => [s.spec.label, s.pid, s.running, s.release]),
		[[SERVE_SERVICE.label, 4242, "1.0.0", "2.0.0"]],
	);
});

test("on a Mac, a serve that lsof shows in the release's own folder is not stale", () => {
	const l = layout("mac-current");
	macSeam({ ps: join(l.root, "local-studio-browser"), lsof: join(l.current, "local-studio-browser") });
	// The release as currentRelease names it: resolved (a Mac's tmpdir is under the /var link).
	assert.deepEqual(withHome(l.home, () => staleServices(realpathSync(l.current), { root: l.root })), []);
});

test("without lsof, a program named by the pointer runs what the pointer named before install moved it", () => {
	const l = layout("mac-ps");
	macSeam({ ps: join(l.root, "local-studio-browser") });
	const stale = withHome(l.home, () => staleServices(l.current, { root: l.root, before: l.old }));
	assert.deepEqual(stale.map((s) => s.running), ["1.0.0"]);
	// Not knowing what it named before, the version can't be told, so it isn't counted (resolving the pointer now would say 2.0.0).
	assert.deepEqual(withHome(l.home, () => staleServices(l.current, { root: l.root })), []);
});

// ---------- A restart keeps the folders the service was set up with ----------

const FOLDER_KEYS = ["LOCAL_STUDIO_BROWSER_DIR", "LOCAL_STUDIO_BROWSER_DIR", "LOCAL_STUDIO_BROWSER_DIR", "XDG_CONFIG_HOME", "LOCAL_STUDIO_BROWSER_SOCKET_DIR", "LOCAL_STUDIO_BROWSER_SOCKET_DIR", "LOCAL_STUDIO_BROWSER_SERVE_WAIT_MS", "LOCAL_STUDIO_BROWSER_RELEASE_BEFORE"];

/** HOME as given, this shell with no config folder of its own (so it would pick the default one), and quick read-backs. */
async function asShell(home, fn) {
	const was = Object.fromEntries(["HOME", ...FOLDER_KEYS].map((k) => [k, process.env[k]]));
	for (const k of FOLDER_KEYS) delete process.env[k];
	process.env.HOME = home;
	process.env.LOCAL_STUDIO_BROWSER_SERVE_WAIT_MS = "2000";
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(was)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A config folder of the service's own, with a launcher that runs the old version, as setup left it. */
function customFolder(l) {
	const config = join(l.home, "Custom Config");
	mkdirSync(config, { recursive: true });
	const launcher = join(config, "local-studio-browser");
	writeFileSync(launcher, `#!/bin/sh\nexec "${join(l.old, "local-studio-browser")}" "$@"\n`, { mode: 0o755 });
	return { config, launcher };
}

test("on a Mac, restarting a stale serve keeps the plist and its own config folder, and only asks launchd to restart it", async () => {
	const l = layout("mac-restart");
	const { config, launcher } = customFolder(l);
	const plist = join(l.home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`);
	const text = plistText(launcher, { LOCAL_STUDIO_BROWSER_DIR: config }, join(l.home, "Library", "Logs", "local-studio-browser-serve.log"), SERVE_SERVICE);
	writeFileSync(plist, text);
	// Until launchd restarts it, pid 4242 runs the old version (ps names that folder too); after, pid 4343 runs the release.
	let restarted = false;
	const calls = [];
	setServiceSeamForTests({
		platform: "darwin",
		exec: (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			const pid = restarted ? 4343 : 4242;
			const folder = restarted ? l.current : l.old;
			if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: `\tpid = ${pid}\n` } : { code: 113, out: "" };
			if (cmd === "launchctl" && (args[0] === "kickstart" || args[0] === "bootstrap")) restarted = true;
			if (cmd === "/usr/sbin/lsof") return { code: 0, out: `p${pid}\nn${join(folder, "local-studio-browser")}\n` };
			if (cmd === "/bin/ps") return { code: 0, out: `${join(folder, "local-studio-browser")}\n` };
			return { code: 0, out: "" };
		},
	});
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "local-studio-browser"), (line) => said.push(line)));
	assert.equal(code, 0, said.join("\n"));
	assert.match(said.join("\n"), /Restarted com\.localstudio\.browser\.serve: 1\.0\.0 -> 2\.0\.0/);
	assert.equal(readFileSync(plist, "utf8"), text, "the plist, with its config folder, is as setup wrote it");
	assert.ok(calls.some((c) => c.startsWith("launchctl kickstart -k gui/") && c.endsWith(`/${SERVE_SERVICE.label}`)), calls.join("\n"));
	assert.ok(!calls.some((c) => c.startsWith("launchctl bootout") || c.startsWith("launchctl bootstrap")), calls.join("\n"));
	// The launcher in the service's own folder runs the release's own program, not the program that ran the restart.
	assert.equal(readFileSync(launcher, "utf8"), `#!/bin/sh\nexec "${join(realpathSync(l.current), "local-studio-browser")}" "$@"\n`);
	assert.doesNotMatch(readFileSync(launcher, "utf8"), new RegExp(`${OLD}|${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("on a Mac, install --restart-services restarts a serve that ps names by the moved pointer, read back by lsof", async () => {
	const l = layout("mac-pointer");
	const { config, launcher } = customFolder(l);
	writeFileSync(join(l.home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`), plistText(launcher, { LOCAL_STUDIO_BROWSER_DIR: config }, join(l.home, "serve.log"), SERVE_SERVICE));
	// ps names the program by the path it was started through, the pointer, before and after the restart; lsof names the folder.
	let restarted = false;
	setServiceSeamForTests({
		platform: "darwin",
		exec: (cmd, args) => {
			const pid = restarted ? 4343 : 4242;
			if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: `\tpid = ${pid}\n` } : { code: 113, out: "" };
			if (cmd === "launchctl" && (args[0] === "kickstart" || args[0] === "bootstrap")) restarted = true;
			if (cmd === "/usr/sbin/lsof") return { code: 0, out: `p${pid}\nn${join(restarted ? l.current : l.old, "local-studio-browser")}\n` };
			if (cmd === "/bin/ps") return { code: 0, out: `${join(l.root, "local-studio-browser")}\n` };
			return { code: 0, out: "" };
		},
	});
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "local-studio-browser"), (line) => said.push(line)));
	assert.equal(code, 0, said.join("\n"));
	assert.match(said.join("\n"), /Restarted com\.localstudio\.browser\.serve: 1\.0\.0 -> 2\.0\.0 .*pid 4343/);
	assert.equal(restarted, true, "launchd was asked to restart serve");
});

test("on Linux, restarting a serve keeps its unit and config folder, and only runs systemctl restart", async () => {
	const l = layout("linux-restart");
	const { config, launcher } = customFolder(l);
	const unit = join(l.home, ".config", "systemd", "user", SERVE_SERVICE.unit);
	mkdirSync(join(l.home, ".config", "systemd", "user"), { recursive: true });
	const text = unitText(launcher, { LOCAL_STUDIO_BROWSER_DIR: config }, SERVE_SERVICE);
	writeFileSync(unit, text);
	const calls = [];
	setServiceSeamForTests({ platform: "linux", exec: (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, out: "" }) });
	const r = await asShell(l.home, () => mod.service.restartService(SERVE_SERVICE, join(l.current, "local-studio-browser")));
	assert.equal(r.ok, true, r.message);
	assert.equal(readFileSync(unit, "utf8"), text);
	assert.deepEqual(calls, [`systemctl --user restart ${SERVE_SERVICE.unit}`]);
});

test("a unit that names a version folder's program directly is written again with the config folder it had saved", async () => {
	const l = layout("linux-direct");
	const { config } = customFolder(l);
	const unit = join(l.home, ".config", "systemd", "user", SERVE_SERVICE.unit);
	mkdirSync(join(l.home, ".config", "systemd", "user"), { recursive: true });
	writeFileSync(unit, unitText(join(l.old, "local-studio-browser"), { LOCAL_STUDIO_BROWSER_DIR: config }, SERVE_SERVICE));
	const calls = [];
	const launcher = join(l.home, ".local-studio", "browser", "local-studio-browser");
	setServiceSeamForTests({ platform: "linux", launcher, exec: (cmd, args) => (calls.push([cmd, ...args].join(" ")), { code: 0, out: "" }) });
	const r = await asShell(l.home, () => mod.service.restartService(SERVE_SERVICE, join(l.current, "local-studio-browser")));
	assert.equal(r.ok, true, r.message);
	const now = readFileSync(unit, "utf8");
	assert.doesNotMatch(now, new RegExp(OLD), "the unit no longer names the old version");
	assert.match(now, new RegExp(`^Environment="LOCAL_STUDIO_BROWSER_DIR=${config}"$`, "m"));
	assert.deepEqual(calls.slice(-1), [`systemctl --user restart ${SERVE_SERVICE.unit}`]);
	// The unit names the launcher, and the launcher runs the release's own program: the version the restart is for.
	assert.equal(await asShell(l.home, () => mod.service.serviceProgram(SERVE_SERVICE)), launcher, "the unit names the launcher");
	assert.equal(readFileSync(launcher, "utf8"), `#!/bin/sh\nexec "${join(l.current, "local-studio-browser")}" "$@"\n`);
});

// ---------- Restarts run the release's program, keep the person's own scripts, and --dry-run only lists ----------

/** A Mac whose serve plist names `program` with the service's own config folder; pid 4242 runs OLD until launchd restarts it. */
function restartingMac(l, program, { moves = true } = {}) {
	const plist = join(l.home, "Library", "LaunchAgents", `${SERVE_SERVICE.label}.plist`);
	const config = join(l.home, "Custom Config");
	writeFileSync(plist, plistText(program, { LOCAL_STUDIO_BROWSER_DIR: config }, join(l.home, "serve.log"), SERVE_SERVICE));
	let restarted = false;
	const calls = [];
	setServiceSeamForTests({
		platform: "darwin",
		exec: (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			const now = restarted && moves;
			if (cmd === "launchctl" && args[0] === "print") return args[1].endsWith(SERVE_SERVICE.label) ? { code: 0, out: `\tpid = ${now ? 4343 : 4242}\n` } : { code: 113, out: "" };
			if (cmd === "launchctl" && (args[0] === "kickstart" || args[0] === "bootstrap")) restarted = true;
			if (cmd === "/usr/sbin/lsof") return { code: 0, out: `p${now ? 4343 : 4242}\nftxt\nn${join(now ? l.current : l.old, "local-studio-browser")}\nftxt\nn/usr/lib/dyld\n` };
			return cmd === "launchctl" ? { code: 0, out: "" } : { code: 1, out: "" };
		},
	});
	return { plist, calls, restarts: () => calls.filter((c) => /^launchctl (kickstart|bootstrap|bootout)/.test(c)) };
}

test("install --restart-services --dry-run lists the stale services and restarts nothing", async () => {
	const l = layout("mac-dry");
	const { launcher } = customFolder(l);
	const before = readFileSync(launcher, "utf8");
	const { restarts } = restartingMac(l, launcher);
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "local-studio-browser"), (line) => said.push(line), { dryRun: true }));
	assert.equal(code, 0, said.join("\n"));
	assert.match(said.join("\n"), /Would restart com\.localstudio\.browser\.serve: 1\.0\.0 -> 2\.0\.0 .*pid 4242/);
	assert.match(said.join("\n"), /Nothing was restarted \(--dry-run\)/);
	assert.deepEqual(restarts(), [], "launchd was asked for nothing");
	assert.equal(readFileSync(launcher, "utf8"), before, "the launcher is untouched");
});

test("a restart run by a program that isn't the release still points the launcher at the release's own program", async () => {
	const l = layout("mac-other-program");
	const { launcher } = customFolder(l);
	restartingMac(l, launcher);
	// The restart is run with a program outside the release (a checkout, an npm link): only its name counts.
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(dir, "checkout", "local-studio-browser"), (line) => said.push(line)));
	assert.equal(code, 0, said.join("\n"));
	const text = readFileSync(launcher, "utf8");
	assert.equal(text, `#!/bin/sh\nexec "${join(realpathSync(l.current), "local-studio-browser")}" "$@"\n`);
	for (const other of [process.execPath, process.argv[1], join(dir, "checkout")]) assert.ok(!text.includes(other), `the launcher doesn't name ${other}`);
});

test("when the release's own program is missing, the restart fails with exit 1 and leaves the launcher and service alone", async () => {
	const l = layout("mac-missing");
	const { launcher } = customFolder(l);
	const before = readFileSync(launcher, "utf8");
	rmSync(join(l.current, "local-studio-browser"));
	const { restarts } = restartingMac(l, launcher);
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "local-studio-browser"), (line) => said.push(line)));
	assert.equal(code, 1);
	assert.match(said.join("\n"), /release's program .*local-studio-browser is missing/);
	assert.equal(readFileSync(launcher, "utf8"), before);
	assert.deepEqual(restarts(), []);
});

test("a plist that starts the person's own wrapper script keeps it byte for byte, and a restart still on the old version names it", async () => {
	const l = layout("mac-wrapper");
	const wrapper = join(l.home, "bin", "serve-wrapper.sh");
	mkdirSync(join(l.home, "bin"), { recursive: true });
	const mine = `#!/bin/bash\n# my own: logs, then serve\nexport LOCAL_STUDIO_BROWSER_LOG=debug\nexec "${join(l.old, "local-studio-browser")}" serve "$@"\n`;
	writeFileSync(wrapper, mine, { mode: 0o755 });
	const { plist, calls } = restartingMac(l, wrapper, { moves: false });
	const plistBefore = readFileSync(plist, "utf8");
	const said = [];
	const code = await asShell(l.home, () => restartStaleServices(l.root, join(l.root, "local-studio-browser"), (line) => said.push(line)));
	assert.equal(code, 1, said.join("\n"));
	assert.equal(readFileSync(wrapper, "utf8"), mine, "the wrapper is byte-identical");
	assert.equal(readFileSync(plist, "utf8"), plistBefore, "the plist is untouched");
	assert.ok(calls.some((c) => c.startsWith("launchctl kickstart -k ")), calls.join("\n"));
	assert.match(said.join("\n"), new RegExp(`your own ${wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which Local Studio doesn't change\\. Point it at .*${NEW}`));
});

test("a Mac process is read from real lsof -Fn output: the program first, then dyld", () => {
	// Captured from /usr/sbin/lsof -a -p <pid> -d txt -Fn on macOS 27 for a program in a version folder.
	const l = layout("mac-real-lsof");
	const out = `p71041\nftxt\nn${join(l.old, "local-studio-browser")}\nftxt\nn/usr/lib/dyld\n`;
	setServiceSeamForTests({ platform: "darwin", exec: (cmd) => (cmd === "/usr/sbin/lsof" ? { code: 0, out } : { code: 1, out: "" }) });
	assert.equal(mod.service.processProgram(71041), join(l.old, "local-studio-browser"));
});
