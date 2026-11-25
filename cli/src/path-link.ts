/**
 * Puts `local-studio-browser` on PATH after a release install: `~/.local/bin/local-studio-browser`, a symlink to the release pointer's program
 * (`<base>/release/local-studio-browser`), so it follows every later install without being touched again. Every command Local Studio
 * prints says `local-studio-browser <command>`; without this link a release install left nothing by that name on PATH.
 *
 * A link that already runs a Local Studio program (an older release, a checkout's `cli/dist/index.js`, an npm install of
 * the `local-studio-browser` package) or runs nothing is repointed. Anything else is someone's own: in a terminal the install asks,
 * default no; without one it is left alone and the install prints the one command that repoints it. macOS and Linux only:
 * Windows has no `~/.local/bin` on PATH by default.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { releaseBase, releaseProgram } from "./paths.ts";
import { c, confirm, sym } from "./ui.ts";

/** The folder the link goes in. */
export function userBinDir(): string {
	return join(homedir(), ".local", "bin");
}

/**
 * What `~/.local/bin/local-studio-browser` is now. "current": a link to the release pointer. "missing": nothing there. "ours": a
 * link to a Local Studio program or to nothing, safe to repoint. "other": a link to something else, or a plain file.
 */
export interface PathLink {
	link: string;
	target: string;
	state: "current" | "missing" | "ours" | "other";
	/** What the link names now, resolved, or the link itself when it is a plain file. */
	found?: string;
}

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function packageName(file: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name as string | undefined;
	} catch {
		return undefined;
	}
}

/**
 * True for a Local Studio program: anything under the release folder, a release unpacked elsewhere (`local-studio-browser` with its
 * `extension/` beside it), or the CLI of the `local-studio-browser` package (`dist/index.js`), a checkout's or an npm install's.
 */
export function isLocalStudioProgram(path: string, base: string = releaseBase()): boolean {
	const real = realOr(path);
	if (real.startsWith(realOr(base) + sep)) return true;
	if (/^local-studio-browser(\.exe)?$/.test(basename(real)) && existsSync(join(dirname(real), "extension", "manifest.json"))) return true;
	if (basename(real) !== "index.js" || basename(dirname(real)) !== "dist") return false;
	const pkg = dirname(dirname(real));
	return packageName(join(pkg, "package.json")) === "local-studio-browser";
}

export function inspectLink(target: string = releaseProgram(), dir: string = userBinDir()): PathLink {
	const link = join(dir, "local-studio-browser");
	let isLink: boolean;
	try {
		isLink = lstatSync(link).isSymbolicLink();
	} catch {
		return { link, target, state: "missing" };
	}
	if (!isLink) return { link, target, state: "other", found: link };
	const found = resolve(dirname(link), readlinkSync(link));
	if (found === target) return { link, target, state: "current", found };
	// A link to nothing runs nothing, so pointing it at the release loses nothing.
	if (!existsSync(found) || isLocalStudioProgram(found)) return { link, target, state: "ours", found };
	return { link, target, state: "other", found };
}

/** Make the link, replacing what is there in one rename. */
function writeLink(state: PathLink): void {
	mkdirSync(dirname(state.link), { recursive: true });
	const temp = join(dirname(state.link), `.local-studio-browser-link-${process.pid}`);
	rmSync(temp, { force: true });
	symlinkSync(state.target, temp);
	renameSync(temp, state.link);
}

/** The line that adds the folder to PATH for this person's shell. */
function pathAdvice(dir: string): string {
	const shell = basename(process.env.SHELL ?? "");
	if (shell === "fish") return `fish_add_path ${dir}`;
	const rc = shell === "zsh" ? "~/.zshrc" : shell === "bash" ? (process.platform === "darwin" ? "~/.bash_profile" : "~/.bashrc") : "~/.profile";
	return `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}, then open a new terminal`;
}

/** The first `local-studio-browser` on PATH, if any. */
function firstOnPath(): string | undefined {
	for (const entry of (process.env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, "local-studio-browser");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Point `~/.local/bin/local-studio-browser` at the release, as the module comment says, then say whether typing `local-studio-browser` reaches
 * it: the folder may be missing from PATH, or another `local-studio-browser` may come first. Never fails the install.
 */
export async function linkOnPath(options: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<void> {
	if (process.platform === "win32") return;
	const log = options.log ?? ((line: string) => console.log(line));
	const state = inspectLink();
	const fix = `ln -sf '${state.target}' '${state.link}'`;
	if (state.state === "current") log(`${sym.ok} ${c.dim(`${state.link} -> ${state.target}`)}`);
	else if (state.state === "missing" || state.state === "ours") {
		const was = state.found ? ` (it ran ${state.found})` : "";
		if (options.dryRun) log(`${sym.ok} Would link ${c.dim(`${state.link} -> ${state.target}`)}${was}`);
		else {
			try {
				writeLink(state);
				log(`${sym.ok} Linked ${c.dim(`${state.link} -> ${state.target}`)}${was}`);
			} catch (err) {
				log(`${sym.warn} Couldn't link ${state.link} (${(err as Error).message}). Run: ${fix}`);
				return;
			}
		}
	} else {
		const what = state.found === state.link ? "is a file this helper didn't make" : `runs ${state.found}, which isn't this helper`;
		if (options.dryRun) log(`${sym.warn} Would ask before replacing ${state.link}: it ${what}.`);
		else if (process.stdin.isTTY && (await confirm(`${sym.dot} ${state.link} ${what}. Point it at ${state.target}?`, { assumeYes: false, defaultYes: false }))) {
			writeLink(state);
			log(`${sym.ok} Linked ${c.dim(`${state.link} -> ${state.target}`)}`);
		} else {
			log(`${sym.warn} ${state.link} ${what}, so it was left alone and typing local-studio-browser doesn't run this release. To use this release: ${fix}`);
			return;
		}
	}
	if (options.dryRun) return;
	const dir = realOr(dirname(state.link));
	const onPath = (process.env.PATH ?? "").split(delimiter).some((entry) => entry && realOr(entry) === dir);
	if (!onPath) {
		log(`${sym.warn} ${dirname(state.link)} isn't on your PATH, so typing local-studio-browser won't find it. Add it: ${pathAdvice(dirname(state.link))}`);
		return;
	}
	const first = firstOnPath();
	if (first && realOr(first) !== realOr(state.target)) {
		log(`${sym.warn} Another local-studio-browser comes first on your PATH: ${first}. Remove it, or put ${dirname(state.link)} before its folder.`);
	}
}
