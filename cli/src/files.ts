/**
 * Small private-file helpers for the config directory: JSON read/write at 0600 with an atomic
 * rename, and an exclusive lock file for read-modify-write across processes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envVar } from "./env.ts";

/** The parsed JSON file, or `fallback` when it doesn't exist. A file that exists but isn't JSON throws. */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write JSON with mode 0600 through a temp file, so a reader never sees half a file. */
export function writeJsonPrivate(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** A lock file stayed held past the caller's patience. Request handlers map it to 503. */
export class LockTimeoutError extends Error {}

/**
 * Run `fn` holding an exclusive lock file next to `path`; gives up after `timeoutMs`. A lock older than 30 seconds is stale.
 * The lock records an owner token and is removed only while it still holds that token, so a holder whose lock
 * was taken as stale never deletes the next holder's lock.
 */
export function withFileLock<T>(path: string, fn: () => T, timeoutMs = 10_000): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > 30_000;
			} catch {
				/* gone */
			}
			if (stale) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			/* already gone */
		}
	}
}

/**
 * Like `withFileLock`, for work that awaits while it holds the lock. The wait polls with a timer, so
 * the event loop keeps running meanwhile. Same lock file, same 30-second stale rule, so hold it only
 * for short work (a check and a write), never across a network call or a service manager. The lock
 * records an owner token (pid and a random nonce) and is removed only while it still holds that
 * token, so a holder whose lock was taken as stale never deletes the next holder's lock.
 */
export async function withFileLockAsync<T>(path: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > 30_000;
			} catch {
				/* gone */
			}
			if (stale) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			else await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			/* already gone */
		}
	}
}

const EXT = process.platform === "win32" ? ".cmd" : "";

/** What the native host launcher is called inside the config folder. */
export const HOST_LAUNCHER_NAME = `local-studio-browser-host${EXT}`;
/** What the agent launcher is called inside the config folder. */
export const CLI_LAUNCHER_NAME = `local-studio-browser${EXT}`;

/** The folder a person chose for the config (LOCAL_STUDIO_BROWSER_DIR), if any. */
export function configDirOverride(): string | undefined {
	return process.env.LOCAL_STUDIO_BROWSER_DIR || undefined;
}

/** Local Studio's data folder: $LOCAL_STUDIO_DATA_DIR, else ~/.local-studio (Local Studio's core/src/plugins.rs). */
export function localStudioDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.LOCAL_STUDIO_DATA_DIR || join(homedir(), ".local-studio");
}

/** The helper's config folder where no override is set. */
export function defaultConfigDir(): string {
	return join(localStudioDataDir(), "browser");
}

/** The helper's config folder: the override, else the browser folder in Local Studio's data folder. */
export function configDir(): string {
	return configDirOverride() ?? defaultConfigDir();
}

/** The folder user data lives under: $XDG_DATA_HOME, else ~/.local/share. */
export function dataHome(): string {
	return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** Local Studio's data directory (the installed release, thread mirror, Copilot SDK): LOCAL_STUDIO_BROWSER_HOME, else <data>/local-studio-browser. */
export function dataDir(): string {
	return envVar("HOME") || join(dataHome(), "local-studio-browser");
}

/** Local Studio's cache directory: LOCAL_STUDIO_BROWSER_CACHE_DIR, else $XDG_CACHE_HOME or ~/.cache, then local-studio-browser. */
export function cacheDir(): string {
	return envVar("CACHE_DIR") || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "local-studio-browser");
}
