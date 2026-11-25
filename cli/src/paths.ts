import { lstatSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledExtensionDir } from "./self.ts";
import { envVar } from "./env.ts";

/**
 * Socket directory: per user, outside $TMPDIR so every process finds the same path.
 * LOCAL_STUDIO_BROWSER_SOCKET_DIR overrides it (tests run a private bridge this way).
 */
export function socketDir(): string {
	return socketDirs()[0];
}

/** Where clients look for hosts. */
export function socketDirs(): string[] {
	const user = userInfo().username;
	if (process.platform === "win32") return [`\\\\.\\pipe\\local-studio-browser-${user}`];
	const override = envVar("SOCKET_DIR");
	if (override) return [override];
	return [`/tmp/local-studio-browser-${user}`];
}

export function socketPath(pid: number): string {
	if (process.platform === "win32") return `${socketDir()}-${pid}`;
	return join(socketDir(), `${pid}.sock`);
}

/** The path's own stat. A link, or another user's file, is refused; a link among its parents (macOS's /tmp) is fine. */
function ownStat(path: string): Stats {
	// resolve drops a trailing slash, which would make lstat follow a link.
	const st = lstatSync(resolve(path));
	if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
	if (st.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
	return st;
}

/** Refuse a path that isn't our own real directory; returns its stat. POSIX only. */
export function assertOwnDir(path: string): Stats {
	const st = ownStat(path);
	if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
	return st;
}

/**
 * Refuse a directory or socket that another user could have planted: it must be
 * ours, not a symlink, and closed to everyone else. Mirrors what Claude Code checks.
 */
export function assertSecurePath(path: string, expected: "dir" | "socket"): void {
	if (process.platform === "win32") return;
	const st = expected === "dir" ? assertOwnDir(path) : ownStat(path);
	const mode = st.mode & 0o777;
	if (expected === "dir") {
		if (mode !== 0o700) throw new Error(`${path} has mode ${mode.toString(8)}, expected 700`);
	} else {
		if (!st.isSocket()) throw new Error(`${path} is not a socket`);
		if (mode & 0o077) throw new Error(`${path} is accessible to other users (mode ${mode.toString(8)})`);
	}
}

/** The repository this CLI was built from (cli/dist/index.js -> repo root). */
export function repoRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The unpacked extension folder users load in the browser. LOCAL_STUDIO_BROWSER_EXTENSION_DIR overrides it (tests). */
export function extensionDir(): string {
	return envVar("EXTENSION_DIR") || bundledExtensionDir() || join(repoRoot(), "dist-chrome");
}

/** Files a loadable build must have; a half-written dist-chrome unloads the extension. */
export const EXTENSION_FILES = ["manifest.json", "background.js", "sidepanel.js", "sidepanel.html", "app.css"];

/** The folder that holds the installed versions, the `release` pointer and the extension folder. */
export function releaseBase(): string {
	if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "LocalStudioBrowser");
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "local-studio-browser");
}

/** The pointer to the current version's folder: the `local-studio-browser` program, `extension/` and `plugins/`. */
export function releaseRoot(): string {
	return join(releaseBase(), "release");
}

/** The release's program inside releaseRoot(). */
export function releaseProgram(root: string = releaseRoot()): string {
	return join(root, process.platform === "win32" ? "local-studio-browser.exe" : "local-studio-browser");
}
