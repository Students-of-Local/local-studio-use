/**
 * How this program starts a copy of itself. From source or the npm bundle that is `node <script> <args>`; a release, and the
 * copy inside the Local Studio app, are one compiled executable (__LOCAL_STUDIO_BROWSER_COMPILED__ set by the build), so it is `<helper> <args>`
 * and there is no Node and no script path to point at.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

declare const __LOCAL_STUDIO_BROWSER_COMPILED__: boolean | undefined;

/** True in the single-executable build. */
export const COMPILED: boolean = typeof __LOCAL_STUDIO_BROWSER_COMPILED__ !== "undefined" && __LOCAL_STUDIO_BROWSER_COMPILED__ === true;

/**
 * True for a release (scripts/package-release.mjs, which puts build-info.json beside the program): `install --release` updates
 * it. Any other compiled copy is the one inside the Local Studio app, which the app updates.
 */
export const RELEASE_BUILD: boolean = COMPILED && existsSync(join(dirname(process.execPath), "build-info.json"));

/**
 * The path a long-lived entry (Eukhe's mcpServers) should name for `program`. A release runs from
 * <base>/versions/<version>-<sha>/, and a later `install --release` removes that folder once nothing runs from it, so
 * a program there is named through <base>/release, the pointer every install moves to the newest version. Any other
 * path is returned as is.
 */
export function stableReleaseProgram(program: string): string {
	const versions = dirname(dirname(program));
	if (basename(versions) !== "versions") return program;
	return join(dirname(versions), "release", basename(program));
}

/** The file a launcher or manifest must run: the helper itself when compiled, else Node. */
export function selfExec(): string {
	return process.execPath;
}

/** The arguments that make `selfExec()` run this program, before the command's own. */
export function selfPrefix(script: string | undefined = process.argv[1]): string[] {
	return COMPILED || !script ? [] : [script];
}

/**
 * Where the bundled extension folder sits: next to the helper (inside the app too). A
 * release installed by `install --release` runs from <base>/versions/<version>/, and the browser loads the copy in the
 * fixed folder <base>/extension, which outlives each version folder.
 */
export function bundledExtensionDir(): string | undefined {
	if (!COMPILED) return undefined;
	const dir = dirname(process.execPath);
	if (RELEASE_BUILD && basename(dirname(dir)) === "versions") return join(dirname(dirname(dir)), "extension");
	return join(dir, "extension");
}

/** The command a person types for this program, whatever file runs it. */
export const COMMAND_NAME = "local-studio-browser";

/** The MCP server's name when `mcp --name` is not given. */
export const DEFAULT_MCP_NAME = "local-studio";
