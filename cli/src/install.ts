/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `local-studio-browser mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import { NATIVE_HOST_NAME, NATIVE_HOST_NAMES } from "../../src/bridge/protocol.ts";
import { COMPILED, selfExec, selfPrefix } from "./self.ts";
import { VERSION } from "./version.ts";
import { envVar } from "./env.ts";
import { CLI_LAUNCHER_NAME, cacheDir, configDir, HOST_LAUNCHER_NAME } from "./files.ts";

/**
 * Stable id from the `key` in static/manifest.chrome.json: unpacked and bundled copies. The one place it is written is
 * src/bridge/extension-id.json, which the tests read too (cli/test/release-install.test.mjs checks it against the key).
 */
export const EXTENSION_ID: string = extensionId.id;

/** The id Google assigned the Chrome Web Store listing. Empty until the first upload. */
export const STORE_EXTENSION_ID: string = "";

/** Every extension allowed to talk to the native host: the unpacked copy, and the store copy once it exists. */
export function extensionOrigins(storeId: string = STORE_EXTENSION_ID): string[] {
	return [EXTENSION_ID, storeId].filter(Boolean).map((id) => `chrome-extension://${id}/`);
}

/** True when a host manifest allows exactly today's extensions. An older file gets rewritten. */
export function originsCurrent(origins: unknown, storeId: string = STORE_EXTENSION_ID): boolean {
	return JSON.stringify(origins) === JSON.stringify(extensionOrigins(storeId));
}

export interface BrowserDir {
	name: string;
	dir: string;
}

/** User-data directories of the Chromium browsers we register with. */
export function browserDirs(): BrowserDir[] {
	const home = homedir();
	if (process.platform === "darwin") {
		const base = join(home, "Library", "Application Support");
		return [
			{ name: "Helium", dir: join(base, "net.imput.helium") },
			{ name: "Chrome", dir: join(base, "Google", "Chrome") },
			{ name: "Chrome Beta", dir: join(base, "Google", "Chrome Beta") },
			{ name: "Chrome Canary", dir: join(base, "Google", "Chrome Canary") },
			{ name: "Chromium", dir: join(base, "Chromium") },
			{ name: "Brave", dir: join(base, "BraveSoftware", "Brave-Browser") },
			{ name: "Edge", dir: join(base, "Microsoft Edge") },
			{ name: "Arc", dir: join(base, "Arc", "User Data") },
			{ name: "Vivaldi", dir: join(base, "Vivaldi") },
			{ name: "Opera", dir: join(base, "com.operasoftware.Opera") },
		];
	}
	if (process.platform === "linux") {
		const cfg = process.env.XDG_CONFIG_HOME || join(home, ".config");
		return [
			{ name: "Helium", dir: join(cfg, "net.imput.helium") },
			{ name: "Chrome", dir: join(cfg, "google-chrome") },
			{ name: "Chrome Beta", dir: join(cfg, "google-chrome-beta") },
			{ name: "Chromium", dir: join(cfg, "chromium") },
			{ name: "Brave", dir: join(cfg, "BraveSoftware", "Brave-Browser") },
			{ name: "Edge", dir: join(cfg, "microsoft-edge") },
			{ name: "Vivaldi", dir: join(cfg, "vivaldi") },
			{ name: "Opera", dir: join(cfg, "opera") },
		];
	}
	return [];
}

/** The app each browser ships as on a Mac, by the name browserDirs() gives it. */
const MAC_APPS: Record<string, string> = {
	Helium: "Helium",
	Chrome: "Google Chrome",
	"Chrome Beta": "Google Chrome Beta",
	"Chrome Canary": "Google Chrome Canary",
	Chromium: "Chromium",
	Brave: "Brave Browser",
	Edge: "Microsoft Edge",
	Arc: "Arc",
	Vivaldi: "Vivaldi",
	Opera: "Opera",
};

/** Each browser's bundle identifier, for finding its app wherever it lives (Launch Services knows; the fixed folders may not). */
const MAC_BUNDLE_IDS: Record<string, string> = {
	Helium: "net.imput.helium",
	Chrome: "com.google.Chrome",
	"Chrome Beta": "com.google.Chrome.beta",
	"Chrome Canary": "com.google.Chrome.canary",
	Chromium: "org.chromium.Chromium",
	Brave: "com.brave.Browser",
	Edge: "com.microsoft.edgemac",
	Arc: "company.thebrowser.Browser",
	Vivaldi: "com.vivaldi.Vivaldi",
	Opera: "com.operasoftware.Opera",
};

/** The browser (by browserDirs() name) for a Mac app name such as "Google Chrome", or the app name itself if it isn't one we list. */
export function browserNameForApp(app: string): string {
	return Object.entries(MAC_APPS).find(([, a]) => a === app)?.[0] ?? app;
}

const spotlight = new Map<string, boolean>();
/** Does Launch Services (through Spotlight's index) know an app with this bundle id? Asked once per id. */
function knownToSpotlight(id: string): boolean {
	const seen = spotlight.get(id);
	if (seen !== undefined) return seen;
	let found = false;
	try {
		found = execFileSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], { encoding: "utf8", timeout: 3000 }).trim().length > 0;
	} catch {
		/* no Spotlight, or it timed out: the fixed folders decide */
	}
	spotlight.set(id, found);
	return found;
}

/**
 * Is the browser really installed? A data folder outlives the app (uninstalled browsers leave theirs), so on a Mac the app
 * must be in an Applications folder. LOCAL_STUDIO_BROWSER_APPLICATIONS_DIRS (a PATH-style list) replaces the folders, for tests.
 * Elsewhere the data folder is all there is to go on.
 */
export function browserInstalled(name: string): boolean {
	if (process.platform !== "darwin") return true;
	const app = MAC_APPS[name];
	if (!app) return true;
	const override = envVar("APPLICATIONS_DIRS");
	const dirs = override ? override.split(delimiter) : ["/Applications", join(homedir(), "Applications")];
	if (dirs.some((dir) => existsSync(join(dir, `${app}.app`)))) return true;
	// An app outside the top of an Applications folder (Setapp, an external drive): ask by bundle id. Not under test overrides.
	const id = MAC_BUNDLE_IDS[name];
	return !override && id !== undefined && knownToSpotlight(id);
}

/**
 * The browsers with a data folder here and the app installed. `live` names browsers a running connection says hold the extension:
 * they are in use even if their app can't be found. A manifest left in a data folder proves nothing (uninstalling the app keeps it).
 */
export function installedBrowserDirs(live: readonly string[] = []): BrowserDir[] {
	return browserDirs().filter(({ name, dir }) => existsSync(dir) && (browserInstalled(name) || live.includes(name)));
}

/** The browsers that already have one of our manifests, current or not: the ones this install has been registered with. */
export function registeredBrowserNames(): string[] {
	return browserDirs()
		.filter(({ dir }) => NATIVE_HOST_NAMES.some((host) => existsSync(join(dir, "NativeMessagingHosts", `${host}.json`))))
		.map(({ name }) => name);
}

export { CLI_LAUNCHER_NAME, HOST_LAUNCHER_NAME };

export function launcherPath(): string {
	return join(configDir(), HOST_LAUNCHER_NAME);
}

/**
 * The command harness configs run: a launcher that pins Node by absolute path,
 * so harnesses started from a GUI (Cursor, Claude Desktop) work without node on PATH.
 */
export function cliLauncherPath(): string {
	return join(configDir(), CLI_LAUNCHER_NAME);
}

/** Node by its PATH name when that is this same binary (survives upgrades), else execPath. */
function stableNode(): string {
	const exec = process.execPath;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		// A relative PATH entry would make the launcher depend on the directory it runs from.
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
		try {
			if (existsSync(candidate) && realpathSync(candidate) === realpathSync(exec)) return candidate;
		} catch {
			/* unreadable entry */
		}
	}
	return exec;
}

/**
 * What the browser runs for the native host. In a compiled build that is the helper itself (it takes the
 * `chrome-extension://` argument the browser passes as `host`), so the manifest holds one path that
 * moves with the app; elsewhere it is the launcher script.
 */
export function hostTarget(): string {
	return COMPILED ? selfExec() : launcherPath();
}

function writeScript(path: string, args: string, options: { compileCache?: boolean } = {}): void {
	if (COMPILED) {
		// The helper is the whole program: no Node to pin, no script, no compile cache.
		if (process.platform === "win32") writeFileSync(path, `@echo off\r\n"${selfExec()}" ${args} %*\r\n`);
		else {
			writeFileSync(path, `#!/bin/sh\nexec "${selfExec()}" ${args}"$@"\n`);
			chmodSync(path, 0o755);
		}
		return;
	}
	const node = stableNode();
	const script = selfPrefix()[0] ?? process.argv[1];
	if (process.platform === "win32") {
		writeFileSync(path, `@echo off\r\n"${node}" "${script}" ${args} %*\r\n`);
	} else {
		// Node's compile cache (Node 22.1+; older versions ignore it): a small saving, about 10 ms
		// of 120 on one machine, near run-to-run noise (`cli/eval/bridge-metrics.mjs --only launcher`).
		const cache = join(cacheDir(), "node-compile-cache");
		// Only the launcher harnesses run; the native host's environment (and what it spawns) is unchanged.
		const prefix = options.compileCache ? `: "\${NODE_COMPILE_CACHE:=${cache}}"\nexport NODE_COMPILE_CACHE\n` : "";
		writeFileSync(path, `#!/bin/sh\n${prefix}exec "${node}" "${script}" ${args}"$@"\n`);
		chmodSync(path, 0o755);
	}
}

/** The program a launcher written by this process must run: the helper itself when compiled, else the script that is running. */
function runningProgram(): string | undefined {
	return COMPILED ? selfExec() : (selfPrefix()[0] ?? process.argv[1]);
}

/**
 * Does the agent launcher run this process's program? One that names some other program (an old checkout, an npm link to a
 * build that is gone) starts old code, and a service started from it would run that code too.
 */
export function launcherRunsSelf(path: string = cliLauncherPath()): boolean {
	const program = runningProgram();
	const named = absolutePathsIn(path);
	if (!program || named === undefined) return false;
	const same = (a: string, b: string) => {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return a === b;
		}
	};
	return named.some((p) => same(p, program));
}

/**
 * Rewrite the agent launcher when it is missing or runs another program. Only that one: the host launcher is the browser's
 * business and `install` decides about it. `path` is another config folder's launcher, such as the one a service set up with
 * its own folder runs. Returns true when it wrote.
 */
export function ensureLauncherIsSelf(path: string = cliLauncherPath()): boolean {
	if (launcherRunsSelf(path)) return false;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeScript(path, "", { compileCache: true });
	return true;
}

/**
 * True when `text` is a launcher writeScript wrote, in either shape: `#!/bin/sh` with an optional compile-cache line and one
 * `exec "<program>" ["<script>"] "$@"`, or `@echo off` with one `"<program>" ["<script>"] %*` line. Anything else is a
 * program or a script the person wrote, which Local Studio never rewrites.
 */
export function isLocalStudioLauncherText(text: string): boolean {
	return (
		/^#!\/bin\/sh\n(?:: "\$\{NODE_COMPILE_CACHE:=[^"\n]*\}"\nexport NODE_COMPILE_CACHE\n)?exec "[^"\n]+"(?: "[^"\n]+")? (?:host )?"\$@"\n$/.test(text) ||
		/^@echo off\r\n"[^"\r\n]+"(?: "[^"\r\n]+")? (?:host )?%\*\r\n$/.test(text)
	);
}

/**
 * Point the agent launcher at `path` to `program`, a release's own program, whatever program this process is: a service
 * restarted onto a release must run that release, not a checkout or an older `local-studio-browser` that ran the restart. A `.cmd` or
 * `.bat` path gets the Windows shape. Returns true when it wrote.
 */
export function ensureLauncherRuns(path: string, program: string): boolean {
	const named = absolutePathsIn(path);
	const same = (a: string, b: string) => {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return a === b;
		}
	};
	if (named?.length === 1 && same(named[0], program)) return false;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (/\.(cmd|bat)$/i.test(path)) writeFileSync(path, `@echo off\r\n"${program}" %*\r\n`);
	else {
		writeFileSync(path, `#!/bin/sh\nexec "${program}" "$@"\n`);
		chmodSync(path, 0o755);
	}
	return true;
}

function writeLauncher(): string {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeScript(cliLauncherPath(), "", { compileCache: true });
	const path = launcherPath();
	writeScript(path, "host ");
	return hostTarget();
}

/** The manifest for one host name: the current one unless asked. */
export function manifestFor(launcher: string, host: string = NATIVE_HOST_NAME): string {
	return `${JSON.stringify(
		{
			name: host,
			description: "Local Studio browser bridge",
			path: launcher,
			type: "stdio",
			allowed_origins: extensionOrigins(),
		},
		null,
		2,
	)}\n`;
}

/** Where Windows browsers look up native hosts. */
const WINDOWS_HIVES = ["Google\\Chrome", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge", "Chromium"];

export interface InstallResult {
	launcher: string;
	written: string[];
	skipped: string[];
}

export interface InstallOptions {
	force?: boolean;
	/** Register only this browser (by the name browserDirs() gives it), and touch the launchers only if one of them doesn't work. */
	browser?: string;
	/** Register only these browsers; the launchers are kept as they are while both work. */
	browsers?: readonly string[];
	/** False rewrites the launchers even when they work. */
	keepLaunchers?: boolean;
	/** List what would be written in `written`, and write nothing. */
	dryRun?: boolean;
}

export function install(options: InstallOptions = {}): InstallResult {
	const only = options.browsers ?? (options.browser !== undefined ? [options.browser] : undefined);
	// A chosen set of browsers: working launchers stay as they are, so nothing else is repointed.
	const keepLaunchers = options.keepLaunchers !== false && only !== undefined && launchersWork();
	const launcher = keepLaunchers || options.dryRun ? hostTarget() : writeLauncher();
	const written: string[] = [];
	const skipped: string[] = [];

	if (process.platform === "win32") {
		for (const host of NATIVE_HOST_NAMES) {
			const file = join(configDir(), `${host}.json`);
			if (!options.dryRun) writeFileSync(file, manifestFor(launcher, host));
			for (const hive of WINDOWS_HIVES) {
				const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${host}`;
				if (options.dryRun) {
					written.push(key);
					continue;
				}
				try {
					execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
					written.push(key);
				} catch {
					skipped.push(key);
				}
			}
		}
		return { launcher, written, skipped };
	}

	for (const { name, dir } of browserDirs()) {
		if (!existsSync(dir)) continue;
		if (only !== undefined && !only.includes(name)) continue;
		const hostsDir = join(dir, "NativeMessagingHosts");
		for (const host of NATIVE_HOST_NAMES) {
			const file = join(hostsDir, `${host}.json`);
			const manifest = manifestFor(launcher, host);
			if (!options.force && existsSync(file) && readFileSync(file, "utf8") === manifest) {
				skipped.push(file);
				continue;
			}
			if (options.dryRun) {
				written.push(file);
				continue;
			}
			mkdirSync(hostsDir, { recursive: true });
			writeFileSync(file, manifest);
			written.push(file);
		}
	}
	return { launcher, written, skipped };
}

/** The program a host manifest names, or undefined when the file isn't there or isn't one. */
export function manifestProgram(file: string): string | undefined {
	try {
		const { path } = JSON.parse(readFileSync(file, "utf8")) as { path?: unknown };
		return typeof path === "string" ? path : undefined;
	} catch {
		return undefined;
	}
}

/** Does a manifest's `program` start this one: the program itself, or a launcher script that execs it? */
function namesSelf(program: string | undefined): boolean {
	const self = thisProgram();
	if (program === undefined || self === undefined) return false;
	if (COMPILED && realOr(program) === realOr(self)) return true;
	try {
		if (firstBytes(program, 2) !== "#!" && !program.endsWith(".cmd")) return false;
	} catch {
		return false;
	}
	return launcherRunsSelf(program);
}

/**
 * Take this program's registration back out of one browser, or every one. A manifest that runs any other program stays as it is.
 */
export function removeHosts(options: { browser?: string; dryRun?: boolean } = {}): { removed: string[]; kept: Array<{ file: string; program?: string }> } {
	const removed: string[] = [];
	const kept: Array<{ file: string; program?: string }> = [];
	for (const host of NATIVE_HOST_NAMES) {
		if (process.platform === "win32") {
			const file = join(configDir(), `${host}.json`);
			if (!existsSync(file)) continue;
			const program = manifestProgram(file);
			if (!namesSelf(program)) {
				kept.push({ file, program });
				continue;
			}
			for (const hive of WINDOWS_HIVES) {
				const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${host}`;
				try {
					if (!execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8" }).includes(file)) continue;
					if (!options.dryRun) execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
					removed.push(key);
				} catch {
					// No such key: that browser isn't registered.
				}
			}
			if (!options.dryRun) rmSync(file, { force: true });
			removed.push(file);
			continue;
		}
		for (const { name, dir } of browserDirs()) {
			if (options.browser !== undefined && options.browser !== name) continue;
			const file = join(dir, "NativeMessagingHosts", `${host}.json`);
			if (!existsSync(file)) continue;
			const program = manifestProgram(file);
			if (!namesSelf(program)) {
				kept.push({ file, program });
				continue;
			}
			if (!options.dryRun) rmSync(file);
			removed.push(file);
		}
	}
	return { removed, kept };
}

/**
 * Does this launcher script run? It exists, is executable, and every program or script it names by absolute path is still
 * there (a deleted checkout leaves a launcher that execs nothing). A bare name such as `node` is the PATH's business.
 */
export function launcherWorks(path: string): boolean {
	const named = absolutePathsIn(path);
	return named !== undefined && named.length > 0 && named.every((p) => existsSync(p));
}

/** The absolute paths a launcher script quotes, or undefined if it isn't there or can't run. */
function absolutePathsIn(path: string): string[] | undefined {
	try {
		if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) return undefined;
		return [...readFileSync(path, "utf8").matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((p) => isAbsolute(p));
	} catch {
		return undefined;
	}
}

/** The first `n` characters of a file, without reading the rest (the helper is a large binary). */
function firstBytes(path: string, n: number): string {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(n);
		const read = readSync(fd, buf, 0, n, 0);
		return buf.subarray(0, read).toString("latin1");
	} finally {
		closeSync(fd);
	}
}

/**
 * What a browser's manifest names: a launcher script (every program it names must still be there) or the helper itself (it must
 * exist and be executable). A script that names nothing has nothing missing.
 */
/** What this helper writes into its launchers: itself when compiled, else its script. */
function thisProgram(): string | undefined {
	return COMPILED ? selfExec() : (selfPrefix()[0] ?? process.argv[1]);
}

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The version a copy of the helper says it is: its build-info.json, its bundled extension, or its checkout's manifest. */
function copyVersion(program: string): string | undefined {
	const dir = dirname(realOr(program));
	for (const file of [join(dir, "build-info.json"), join(dir, "extension", "manifest.json"), join(dir, "..", "..", "static", "manifest.chrome.json")]) {
		try {
			const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
			if (typeof version === "string") return version;
		} catch {
			// The next place, or no version at all.
		}
	}
	return undefined;
}

/** True when version a is lower than version b, compared as dotted numbers. */
function older(a: string, b: string): boolean {
	const x = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const y = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
	return false;
}

/**
 * The program and version when a launcher script runs an older copy of the helper, such as an npm link to a checkout
 * of another version, else undefined. Such a launcher works, so nothing else notices it, while the panel talks to code
 * that doesn't know today's files (an old copy called a valid remote.json unreadable). A current standalone copy, or one
 * with no version to read, is someone's own setup and is left alone.
 */
export function launcherRunsOlder(path: string): { program: string; version: string } | undefined {
	const self = thisProgram();
	if (!self) return undefined;
	try {
		if (firstBytes(path, 2) !== "#!" && !path.endsWith(".cmd")) return undefined;
	} catch {
		return undefined;
	}
	const named = absolutePathsIn(path);
	if (!named?.length) return undefined;
	const mine = realOr(self);
	if (named.some((p) => realOr(p) === mine)) return undefined;
	const program = named[named.length - 1];
	const version = copyVersion(program);
	return version && older(version, VERSION) ? { program, version } : undefined;
}

export function manifestLauncherRuns(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		const head = firstBytes(path, 2);
		if (head !== "#!" && !path.endsWith(".cmd")) return process.platform === "win32" || (statSync(path).mode & 0o111) !== 0;
		const named = absolutePathsIn(path);
		return named !== undefined && named.every((p) => existsSync(p));
	} catch {
		return false;
	}
}

/** Both launchers work: the agent launcher harness configs run and the host launcher the manifests name. */
function launchersWork(): boolean {
	// A launcher that runs an older copy works, but doctor fails it, so install must not keep it.
	return (
		launcherWorks(cliLauncherPath()) &&
		manifestLauncherRuns(hostTarget()) &&
		!launcherRunsOlder(cliLauncherPath()) &&
		!launcherRunsOlder(launcherPath())
	);
}

export type HostState = "current" | "stale" | "missing";

/** For each browser found on this machine: is our host manifest there and current. */
export function hostStatus(): Array<BrowserDir & { state: HostState; file: string }> {
	if (process.platform === "win32") return [];
	const accepted = new Set([hostTarget(), launcherPath()]);
	return installedBrowserDirs().map((browser) => {
		const file = join(browser.dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		let state: HostState = "missing";
		if (existsSync(file)) {
			// Current: it names the helper or a launcher that still runs and isn't an older copy (down to the program the launcher execs), and the one extension id (doctor's test).
			try {
				const m = JSON.parse(readFileSync(file, "utf8")) as { path?: string; allowed_origins?: string[] };
				const ok = typeof m.path === "string" && accepted.has(m.path) && manifestLauncherRuns(m.path) && !launcherRunsOlder(m.path) && originsCurrent(m.allowed_origins);
				state = ok ? "current" : "stale";
			} catch {
				state = "stale";
			}
		}
		return { ...browser, state, file };
	});
}

/**
 * Whether the browser that owns this user-data folder is running: Chromium keeps a `SingletonLock` link there, naming
 * "host-pid", while it runs. A lock from another computer or a process that is gone is left from a crash.
 */
export function browserRunning(dir: string): boolean {
	let lock: string;
	try {
		lock = readlinkSync(join(dir, "SingletonLock"));
	} catch {
		return false;
	}
	const at = lock.lastIndexOf("-");
	const pid = Number(lock.slice(at + 1));
	if (at < 1 || lock.slice(0, at) !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether a profile in this browser folder has the extension and it is on: its id under `extensions.settings` in the
 * profile's Preferences or Secure Preferences, with no disable reason. A host manifest alone says nothing: install
 * writes one into every browser folder.
 */
export function extensionInProfile(dir: string, ids: string[] = [EXTENSION_ID, STORE_EXTENSION_ID].filter(Boolean)): boolean {
	let profiles: string[];
	try {
		profiles = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return false;
	}
	for (const profile of profiles) {
		for (const file of ["Preferences", "Secure Preferences"]) {
			let settings: Record<string, { disable_reasons?: unknown }> | undefined;
			try {
				settings = JSON.parse(readFileSync(join(dir, profile, file), "utf8"))?.extensions?.settings;
			} catch {
				continue;
			}
			for (const id of ids) {
				const reasons = settings?.[id]?.disable_reasons;
				// A list in current Chromium, a bit mask in older ones.
				if (settings?.[id] && !(Array.isArray(reasons) ? reasons.length : reasons)) return true;
			}
		}
	}
	return false;
}

/** True when at least one browser has a current manifest. */
export function isInstalled(): boolean {
	if (process.platform === "win32") return existsSync(join(configDir(), `${NATIVE_HOST_NAME}.json`));
	if (!existsSync(hostTarget())) return false;
	return hostStatus().some((b) => b.state === "current");
}
