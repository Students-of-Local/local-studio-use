/**
 * `local-studio-browser install --release <folder>`: install from a downloaded GitHub release. Every artifact in the folder is
 * checked against the release's SHA256SUMS, and against its build provenance attestation when the GitHub CLI is on
 * PATH and signed in (`gh attestation verify`), before anything is unpacked; one mismatch refuses the whole install. Then the
 * archive for this computer is unpacked into a folder of its own under versions/, and the unpacked `local-studio-browser install`
 * registers itself from there. Only after that works does the `release` pointer (a symlink, a junction on Windows)
 * move to the new version, and the extension is copied to one fixed real folder, so the browser keeps loading it
 * from the same place. A running copy (the native host the browser started, an MCP server) keeps its own folder:
 * an old version is removed only once no program runs from it. On a Mac the new version's own program copies its
 * computer-use helper (`bin/local-studio-computer`) to ~/.local/bin, where `findHelper` (computer.ts) looks.
 *
 * The check is as strong as the program that runs it: a tampered archive could carry a `local-studio-browser` that skips it. To
 * check before running anything from the download, run
 * `gh attestation verify <archive> --repo baney75/local-studio --signer-workflow baney75/local-studio/.github/workflows/browser-release.yml`
 * first, or run this from a copy already installed (an upgrade does exactly that).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { HANDS_COMMAND } from "./computer.ts";
import { browserDirs } from "./install.ts";
import { releaseBase, releaseProgram, releaseRoot } from "./paths.ts";
import { eukheSettingsPath, localStudioPluginsDir, PLUGINS } from "./local-studio.ts";
import { linkOnPath } from "./path-link.ts";
import { NATIVE_HOST_NAMES } from "../../src/bridge/protocol.ts";
import { RELEASE_REPO, RELEASES_URL } from "../../src/release-source.ts";
import { COMMAND_NAME } from "./self.ts";
import { processProgram, servicePlatform, serviceRunner } from "./service.ts";
import { restartCommand, serviceName, staleLines, staleServices, versionName } from "./service-version.ts";
import { c, sym } from "./ui.ts";
import { isNewer } from "./update.ts";

/** A release refused: a missing or wrong checksum, a failed attestation, or no archive for this computer. */
export class ReleaseRefused extends Error {}

/** This computer's archive tag, as the release names it: linux-x64, darwin-arm64, win-x64. */
export function platformTag(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform === "win32" ? "win" : platform}-${arch}`;
}

export { releaseBase, releaseRoot } from "./paths.ts";

/** Every unpacked version, one folder each, named <version>-<first 12 hex of the archive's SHA-256>. */
export function versionsDir(base: string = releaseBase()): string {
	return join(base, "versions");
}

/** The fixed, real folder the browser loads the extension from. A symlink would not do: Chrome stores the path it resolves to. */
export function releaseExtensionDir(base: string = releaseBase()): string {
	return join(base, "extension");
}

// In paths.ts, so remote fix can name it without loading this module (and Local Studio's plugin files with it).
export { releaseProgram } from "./paths.ts";

/** SHA256SUMS lines (`<hex>  <name>`, or `<hex> *<name>` in binary mode) as name -> hex. */
export function parseSums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/i);
		if (m) sums.set(m[2], m[1].toLowerCase());
	}
	return sums;
}

export function sha256File(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The GitHub CLI to check attestations with: LOCAL_STUDIO_BROWSER_GH (a path, or "none" for no gh), else `gh` on PATH. */
export function findGh(): string | undefined {
	const chosen = process.env.LOCAL_STUDIO_BROWSER_GH;
	if (chosen !== undefined && chosen !== "") return chosen === "none" ? undefined : chosen;
	const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

export interface ReleaseCheck {
	/** The archive for this computer, its version and checksum. */
	archive: string;
	version: string;
	sha256: string;
	/** Every artifact the checksums covered. */
	checked: string[];
	/**
	 * How the attestations went: checked by gh, skipped on request, not checked because gh isn't here, or not checked
	 * because gh is here but not signed in (`gh attestation verify` needs a token).
	 */
	attestation: "verified" | "skipped" | "no-gh" | "gh-signed-out";
}

/**
 * True when gh has a github.com account or a GH_TOKEN/GITHUB_TOKEN to use: `gh auth status` exits non-zero otherwise.
 * Judged by the exit code alone, never by gh's wording.
 */
export function ghSignedIn(gh: string): boolean {
	const r = spawnSync(gh, ["auth", "status", "--hostname", "github.com"], { stdio: "ignore", timeout: 30_000 });
	return r.status === 0;
}

/**
 * Check a downloaded release folder. Throws ReleaseRefused on the first problem; writes nothing. Every `local-studio-browser-*`
 * file (not folder) in the folder must be listed in SHA256SUMS and match it, so a stray or swapped file is refused too.
 */
export function verifyRelease(dir: string, options: { skipAttestation?: boolean; log?: (line: string) => void } = {}): ReleaseCheck {
	const log = options.log ?? (() => {});
	const sumsFile = join(dir, "SHA256SUMS");
	if (!existsSync(sumsFile)) throw new ReleaseRefused(`No SHA256SUMS in ${dir}. Download it with the release; without it nothing here can be checked.`);
	const sums = parseSums(readFileSync(sumsFile, "utf8"));
	// Files only: unpacking the archive in the download folder, as README.md says to, leaves its folder beside it.
	const artifacts = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.startsWith("local-studio-browser-"))
		.map((e) => e.name)
		.sort();
	const tag = platformTag();
	const pattern = new RegExp(`^local-studio-browser-(\\d+\\.\\d+\\.\\d+)-${tag}\\.(tar\\.gz|zip)$`);
	const archives = artifacts.filter((f) => pattern.test(f));
	if (archives.length !== 1)
		throw new ReleaseRefused(
			archives.length === 0
				? `No local-studio-browser-<version>-${tag} archive in ${dir}. Download the one for this computer from ${RELEASES_URL}`
				: `More than one archive for this computer in ${dir}: ${archives.join(", ")}. Keep one release per folder.`,
		);
	const archive = archives[0];
	const version = archive.match(pattern)?.[1] ?? "";
	const repo = RELEASE_REPO;
	const workflow = `${RELEASE_REPO}/.github/workflows/browser-release.yml`;
	let archiveSha = "";
	for (const file of artifacts) {
		const want = sums.get(file);
		if (!want) throw new ReleaseRefused(`${file} is not listed in SHA256SUMS. It is not part of this release; remove it or download the release again.`);
		const got = sha256File(join(dir, file));
		if (got !== want) throw new ReleaseRefused(`The SHA-256 of ${file} does not match SHA256SUMS (got ${got}, want ${want}). The download is damaged or was changed; download it again.`);
		if (file === archive) archiveSha = got;
		log(`${file} matches SHA256SUMS`);
	}
	let attestation: ReleaseCheck["attestation"];
	const gh = findGh();
	if (options.skipAttestation) {
		attestation = "skipped";
		log("Attestations not checked (--skip-attestation): SHA256SUMS only.");
	} else if (!gh) {
		attestation = "no-gh";
		log(
			process.env.LOCAL_STUDIO_BROWSER_GH === "none"
				? "LOCAL_STUDIO_BROWSER_GH=none, so the build attestations were not checked: SHA256SUMS only."
				: `gh is not on PATH, so the build attestations were not checked: SHA256SUMS only. With the GitHub CLI installed, this also runs gh attestation verify --repo ${repo}.`,
		);
	} else if (!ghSignedIn(gh)) {
		attestation = "gh-signed-out";
		log("gh is installed but not signed in, so the build attestations were not checked: SHA256SUMS only. Run gh auth login to turn the check on.");
	} else {
		for (const file of artifacts) {
			const r = spawnSync(gh, ["attestation", "verify", join(dir, file), "--repo", repo, "--signer-workflow", workflow], { encoding: "utf8" });
			if (r.status !== 0) {
				const why = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ");
				throw new ReleaseRefused(`gh attestation verify refused ${file}: ${why || `exit ${r.status ?? r.signal}`}. It was not built by ${repo}'s release workflow; nothing was installed.`);
			}
			log(`${file}: build attestation verified (${repo})`);
		}
		attestation = "verified";
	}
	return { archive, version, sha256: archiveSha, checked: artifacts, attestation };
}

const MARKER = ".release-sha256";

/**
 * The tar to unpack with. On Windows that is the system's own bsdtar: Git for Windows puts GNU tar on PATH, which reads
 * `C:\...` as a remote host and fails.
 */
function tarProgram(): string {
	if (process.platform !== "win32") return "tar";
	const system = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
	return existsSync(system) ? system : "tar";
}

/** True when releaseRoot() already holds this exact archive. */
export function releaseCurrent(sha: string, root: string = releaseRoot()): boolean {
	try {
		return readFileSync(join(root, MARKER), "utf8").trim() === sha && existsSync(releaseProgram(root));
	} catch {
		return false;
	}
}

/**
 * Unpack the checked archive into its own folder under versions/, or reuse that folder when it already holds this
 * exact archive. Every entry must sit under the archive's one top folder, with no `..` and no absolute path. Nothing
 * that exists is replaced: a version folder is only ever added.
 */
export function unpackVersion(archivePath: string, version: string, sha: string, base: string = releaseBase()): string {
	const target = join(versionsDir(base), `${version}-${sha.slice(0, 12)}`);
	if (releaseCurrent(sha, target)) return target;
	const zip = archivePath.endsWith(".zip");
	const listing = execFileSync(tarProgram(), [zip ? "-tf" : "-tzf", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split(/\r?\n/)
		.filter(Boolean);
	const top = listing[0]?.split("/")[0];
	if (!top || listing.some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..") || p.split("/")[0] !== top))
		throw new ReleaseRefused(`${archivePath} is not laid out as one release folder; nothing was installed.`);
	mkdirSync(versionsDir(base), { recursive: true });
	const staging = join(base, `.unpack-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging);
	try {
		execFileSync(tarProgram(), [zip ? "-xf" : "-xzf", archivePath, "-C", staging], { stdio: ["ignore", "ignore", "pipe"] });
		const unpacked = join(staging, top);
		writeFileSync(join(unpacked, MARKER), `${sha}\n`);
		// A folder of this name without the marker is an unpack that never finished: nothing was ever run from it.
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		renameSync(unpacked, target);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return target;
}

/** The version folder the `release` pointer names, if it is a pointer. */
function pointerTarget(pointer: string): string | undefined {
	try {
		if (!lstatSync(pointer).isSymbolicLink()) return undefined;
		return resolve(dirname(pointer), readlinkSync(pointer));
	} catch {
		return undefined;
	}
}

/**
 * Point `release` at `target`. On POSIX a new symlink is renamed over the old one, so there is always a pointer. On
 * Windows the old junction is removed (rmdir removes the link, never what it points at) and a new one made. A
 * `release` that is a real folder (the layout before versions/) is moved into versions/ first.
 */
export function switchPointer(target: string, base: string = releaseBase()): void {
	const pointer = join(base, "release");
	let st: ReturnType<typeof lstatSync> | undefined;
	try {
		st = lstatSync(pointer);
	} catch {
		st = undefined;
	}
	if (st && !st.isSymbolicLink()) {
		// Windows reports a junction as a directory here; readlink tells the two apart.
		let junction = false;
		try {
			readlinkSync(pointer);
			junction = true;
		} catch {
			junction = false;
		}
		if (!junction) {
			try {
				renameSync(pointer, join(versionsDir(base), `previous-${process.pid}`));
			} catch (err) {
				throw new ReleaseRefused(`${pointer} is in use by a running Local Studio (${(err as Error).message}). Quit the browser and any agent using Local Studio, then install again.`);
			}
		}
	}
	if (process.platform === "win32") {
		try {
			rmdirSync(pointer);
		} catch {
			/* no pointer yet */
		}
		symlinkSync(target, pointer, "junction");
		return;
	}
	const fresh = join(base, `.release-${process.pid}`);
	rmSync(fresh, { force: true });
	symlinkSync(relative(base, target), fresh);
	renameSync(fresh, pointer);
}

/** Copy the version's extension into the fixed extension folder, swapping the whole folder in one rename where it can. */
export function refreshExtension(versionDir: string, base: string = releaseBase()): string {
	const dest = releaseExtensionDir(base);
	const staged = join(base, `.extension-${process.pid}`);
	rmSync(staged, { recursive: true, force: true });
	cpSync(join(versionDir, "extension"), staged, { recursive: true });
	const old = join(base, `.extension-old-${process.pid}`);
	try {
		if (existsSync(dest)) renameSync(dest, old);
		renameSync(staged, dest);
		rmSync(old, { recursive: true, force: true });
	} catch {
		// A browser on Windows can hold the folder open: copy over it instead.
		if (!existsSync(dest) && existsSync(old)) renameSync(old, dest);
		cpSync(staged, dest, { recursive: true, force: true });
		rmSync(staged, { recursive: true, force: true });
	}
	return dest;
}

/** Where a release puts the Mac computer-use helper: `~/.local/bin/local-studio-computer`, which `findHelper` checks. */
export function handsInstallPath(home: string = homedir()): string {
	return join(home, ".local", "bin", HANDS_COMMAND);
}

/** The computer-use helper a version folder carries, if it carries one for this computer (macOS only, for now). */
export function versionHands(versionDir: string, platform: string = process.platform): string | undefined {
	if (platform !== "darwin") return undefined;
	const path = join(versionDir, "bin", HANDS_COMMAND);
	return existsSync(path) ? path : undefined;
}

/**
 * Copy the version's computer-use helper to `handsInstallPath()`. Copied, not linked: macOS ties the Accessibility grant
 * to the program's real path and, for a program signed ad hoc, to its hash, so one fixed path keeps one entry in System
 * Settings; a link there is replaced by the copy for the same reason. The same bytes are left alone (the grant stays);
 * new bytes go in with a rename, so a running copy keeps its file. `replaced` says an earlier helper was there. Undefined
 * when the version carries no helper here.
 */
export function installHands(versionDir: string, platform: string = process.platform): { path: string; changed: boolean; replaced: boolean } | undefined {
	const from = versionHands(versionDir, platform);
	if (!from) return undefined;
	const dest = handsInstallPath();
	const was = lstatSync(dest, { throwIfNoEntry: false });
	if (was?.isFile() && sha256File(dest) === sha256File(from)) {
		chmodSync(dest, 0o755);
		return { path: dest, changed: false, replaced: false };
	}
	mkdirSync(dirname(dest), { recursive: true });
	const staged = `${dest}.new-${process.pid}`;
	try {
		copyFileSync(from, staged);
		chmodSync(staged, 0o755);
		renameSync(staged, dest);
	} finally {
		rmSync(staged, { force: true });
	}
	return { path: dest, changed: true, replaced: was !== undefined };
}

/**
 * What to tell the person after the helper changed. A grant to the app an agent runs in (Terminal, say) still holds; a
 * grant to the helper itself doesn't, because macOS matches a program signed ad hoc by its hash.
 */
export function handsGrantLine(path: string): string {
	return `If ${HANDS_COMMAND} is listed in System Settings > Privacy & Security > Accessibility, this update needs it allowed again (it is signed ad hoc, so macOS treats each build as new): select it, click -, then click + and add ${path}. computer_status names whatever else macOS needs allowed.`;
}

/**
 * `installHands`, said. Called by the new version's own `install` under `install --release`, so an older program that is
 * upgrading gets the helper too. A copy that fails doesn't stop the browser half: computer use waits for the next install.
 */
export function reportHands(versionDir: string): void {
	try {
		const hands = installHands(versionDir);
		if (hands) console.log(`${sym.ok} Computer-use helper ${c.dim(hands.path)}${hands.changed ? "" : " is already this version"}`);
		if (hands?.replaced) console.log(`${sym.warn} ${handsGrantLine(hands.path)}`);
	} catch (err) {
		console.log(`${sym.warn} The computer-use helper wasn't copied to ${handsInstallPath()}: ${(err as Error).message}`);
	}
}

/**
 * The version folders some running program was started from, or undefined where that can't be told (then nothing is
 * pruned). Linux reads /proc/<pid>/exe, macOS asks ps; Windows is answered by the rename in pruneVersions.
 */
function foldersInUse(folders: string[], base: string): Set<string> | undefined {
	const inUse = new Set<string>();
	// A program's path may have its links resolved where the folder's has not (a linked home or data folder).
	const paths = folders.map((f) => [f, (real(f) ?? f) + sep] as const);
	const mark = (exe: string): boolean => {
		const hit = paths.find(([f, resolved]) => exe.startsWith(f + sep) || exe.startsWith(resolved));
		if (hit) inUse.add(hit[0]);
		return hit !== undefined;
	};
	if (servicePlatform() === "linux") {
		let pids: string[];
		try {
			pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
		} catch {
			return undefined;
		}
		for (const pid of pids) {
			try {
				mark(readlinkSync(`/proc/${pid}/exe`));
			} catch {
				/* gone, or another user's */
			}
		}
		return inUse;
	}
	if (servicePlatform() === "darwin") {
		const r = serviceRunner()("/bin/ps", ["-axo", "pid=,comm="]);
		if (r.code !== 0) return undefined;
		const root = join(base, "release") + sep;
		const versions = versionsDir(base);
		const unpacked = (real(versions) ?? versions) + sep;
		for (const line of r.out.split("\n")) {
			const [, pid, path] = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line) ?? [];
			if (!pid || mark(path)) continue;
			// ps names a program as it was started: through the pointer, or a link to it, that says nothing about the version.
			const linked = path.startsWith(root) || real(path)?.startsWith(unpacked) === true;
			if (!linked && basename(path) !== "local-studio-browser") continue;
			const program = processProgram(Number(pid));
			if (program && real(program) === program) mark(program);
			else if (linked) return undefined;
		}
		return inUse;
	}
	return undefined;
}

/** Remove every version folder but `keep` that no program runs from. Returns the folders removed. */
export function pruneVersions(keep: string, base: string = releaseBase()): string[] {
	const dir = versionsDir(base);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const folders = names.map((n) => join(dir, n)).filter((f) => resolve(f) !== resolve(keep) && resolve(f) !== pointerTarget(join(base, "release")));
	const removed: string[] = [];
	if (process.platform === "win32") {
		// Windows lets a folder holding a running program be renamed, but never lets the running program be deleted:
		// deleting local-studio-browser.exe first is the test. Once it is gone nothing can start from the folder again.
		for (const f of folders) {
			try {
				rmSync(join(f, "local-studio-browser.exe"), { force: true });
			} catch {
				continue;
			}
			try {
				rmSync(f, { recursive: true, force: true, maxRetries: 3 });
				removed.push(f);
			} catch {
				/* a file still open; the next install tries again */
			}
		}
		return removed;
	}
	const inUse = foldersInUse(folders, base);
	if (!inUse) return removed;
	for (const f of folders) {
		if (inUse.has(f)) continue;
		rmSync(f, { recursive: true, force: true });
		removed.push(f);
	}
	return removed;
}

/** How to load the unpacked extension, printed after an install. */
export function loadSteps(extensionDir: string): string[] {
	return [
		"Load the extension once in each browser you use:",
		"  Open chrome://extensions (brave://extensions, edge://extensions), turn on Developer mode, choose Load unpacked, and pick",
		`  ${extensionDir}`,
		"Its id stays the same, so the host manifests above already allow it. A Chrome Web Store listing comes later.",
	];
}

/** Flags `install --release` hands to the unpacked program's own `install`. */
const PASSED_ON = new Set(["--force", "--local-studio", "--browser"]);

/**
 * Check, unpack and register a downloaded release. Returns the exit code. A dry run checks the release, then lists
 * what an install would write; it unpacks and writes nothing.
 */
export async function installFromRelease(dir: string, options: { dryRun?: boolean; skipAttestation?: boolean; noRestart?: boolean; passOn?: string[] }): Promise<number> {
	let check: ReleaseCheck;
	try {
		check = verifyRelease(dir, { skipAttestation: options.skipAttestation, log: (line) => console.log(`${sym.ok} ${line}`) });
	} catch (err) {
		if (!(err instanceof ReleaseRefused)) throw err;
		console.log(`${sym.fail} ${err.message}`);
		return 1;
	}
	const base = releaseBase();
	const root = releaseRoot();
	const target = join(versionsDir(base), `${check.version}-${check.sha256.slice(0, 12)}`);
	const args = ["install"];
	const given = options.passOn ?? [];
	for (let i = 0; i < given.length; i++) {
		const name = given[i].split("=")[0];
		if (!PASSED_ON.has(name)) continue;
		args.push(given[i]);
		if (name === "--browser" && !given[i].includes("=") && given[i + 1] !== undefined) args.push(given[++i]);
	}
	if (options.dryRun) {
		const current = releaseCurrent(check.sha256, target);
		console.log(`${sym.ok} ${current ? "Already unpacked" : "Would unpack"} ${c.dim(`${check.archive} -> ${target}`)}`);
		console.log(`${sym.ok} Would run ${c.dim(`${releaseProgram(target)} ${args.join(" ")}`)}, which writes:`);
		for (const { dir: browserDir } of browserDirs()) {
			if (!existsSync(browserDir)) continue;
			for (const host of NATIVE_HOST_NAMES) console.log(`  ${join(browserDir, "NativeMessagingHosts", `${host}.json`)}`);
		}
		if (args.includes("--local-studio")) {
			for (const id of Object.keys(PLUGINS)) console.log(`  ${join(localStudioPluginsDir(), id)}`);
			console.log(`  ${eukheSettingsPath()} (mcpServers["local-studio"])`);
		}
		console.log(`${sym.ok} Then would point ${c.dim(`${root} -> ${target}`)}, copy its extension to ${c.dim(releaseExtensionDir(base))} and remove older versions no program runs from`);
		await linkOnPath({ dryRun: true });
		if (process.platform === "darwin") console.log(`${sym.ok} Then would copy its computer-use helper, if it has one, to ${c.dim(handsInstallPath())}`);
		const stale = staleServices(versionPath(target), { root, before: real(root) }).map((s) => `${serviceName(s.spec)} (${s.running})`);
		if (stale.length) console.log(`${sym.ok} Then would ${options.noRestart ? "name" : "restart"} the services on another version: ${stale.join(", ")}`);
		return 0;
	}
	const already = releaseCurrent(check.sha256, target);
	try {
		unpackVersion(join(dir, check.archive), check.version, check.sha256, base);
	} catch (err) {
		console.log(`${sym.fail} ${(err as Error).message}`);
		return 1;
	}
	console.log(`${sym.ok} ${already ? `${check.archive} is already installed in` : `Unpacked ${check.archive} into`} ${c.dim(target)}`);
	// The new version registers itself from its own folder; the pointer moves only once that worked.
	const program = releaseProgram(target);
	const r = spawnSync(program, args, { stdio: "inherit", env: { ...process.env, LOCAL_STUDIO_BROWSER_RELEASE_PARENT: "1" } });
	if (r.status !== 0) {
		console.log(`${sym.fail} ${program} ${args.join(" ")} failed (${r.status ?? r.signal ?? r.error?.message}). The installed version is unchanged.`);
		return 1;
	}
	let extension: string;
	// What the pointer names before it moves: a service ps names by the pointer's path runs that version.
	const before = real(root);
	try {
		switchPointer(target, base);
		extension = refreshExtension(target, base);
	} catch (err) {
		console.log(`${sym.fail} ${(err as Error).message}`);
		return 1;
	}
	console.log(`${sym.ok} ${c.dim(`${root} -> ${target}`)}`);
	// `local-studio-browser` on PATH runs the release from now on: ~/.local/bin/local-studio-browser names the pointer, not this version.
	await linkOnPath();
	const restarted = restartServices(target, root, before, options.noRestart === true);
	const removed = pruneVersions(target, base);
	if (removed.length) console.log(`${sym.ok} Removed ${removed.length} older version${removed.length === 1 ? "" : "s"} no program runs from`);
	for (const line of loadSteps(extension)) console.log(line);
	return restarted;
}

const real = (path: string): string | undefined => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};

/** A version folder's path with the versions folder resolved, as staleServices names them; the folder itself may not exist yet. */
const versionPath = (folder: string) => join(real(dirname(folder)) ?? dirname(folder), basename(folder));

/**
 * After the pointer moved: a service keeps the program it was started with, so each Local Studio service still on an older
 * version is restarted by the new version's own program (its install points the services' launcher at itself; this process
 * may be the old one), or with `noRestart` named with the command that restarts it. `before` is the version folder the
 * pointer named before it moved. Returns the exit code.
 */
function restartServices(target: string, root: string, before: string | undefined, noRestart: boolean): number {
	const current = versionPath(target);
	const stale = staleServices(current, { root, before });
	if (!stale.length) return 0;
	const program = releaseProgram(root);
	if (noRestart) {
		for (const line of staleLines(stale, program)) console.log(`${sym.warn} ${line}`);
		return 0;
	}
	const r = spawnSync(releaseProgram(target), ["install", "--restart-services"], {
		stdio: "inherit",
		env: { ...process.env, LOCAL_STUDIO_BROWSER_RELEASE_PARENT: "1", ...(before ? { LOCAL_STUDIO_BROWSER_RELEASE_BEFORE: before } : {}) },
	});
	// Read back here too: a version from before --restart-services would take it for a plain install and exit 0. A process
	// that is still the one found stale runs what the pointer named before; one started since runs what it names now.
	const oldPids = new Set(stale.map((s) => s.pid));
	const left = new Map(staleServices(current, { root, before: current }).map((s) => [s.spec.label, s]));
	for (const s of staleServices(current, { root, before })) if (oldPids.has(s.pid)) left.set(s.spec.label, s);
	if (r.status === 0 && !left.size) return 0;
	// Every service runs the release, but the restart said one failed: serve came back on it and doesn't answer. Running the
	// restart again would find nothing to restart, so this points at what checks and repairs the route.
	if (!left.size && r.status !== null && r.status !== 0) {
		console.log(`${sym.fail} The services were restarted on ${versionName(current)}, but ${COMMAND_NAME} serve doesn't answer. Run: ${COMMAND_NAME} remote status, then ${COMMAND_NAME} remote fix`);
		return 1;
	}
	for (const line of staleLines([...left.values()], program)) console.log(`${sym.fail} ${line}`);
	console.log(`${sym.fail} The services on an older version weren't all restarted (${r.status === 0 ? "still running the old version" : (r.status ?? r.signal ?? r.error?.message)}). Run: ${restartCommand(program)}`);
	return 1;
}
