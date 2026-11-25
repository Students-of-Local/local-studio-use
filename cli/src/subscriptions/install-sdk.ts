/**
 * `local-studio-browser copilot-sdk install`: put GitHub's Copilot SDK, at the version Local Studio pins, where the
 * native host loads it from. Run by the user, never by the extension: it downloads about 160 MB
 * (the SDK's runtime for this platform) from the npm registry.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { COPILOT } from "../../../src/subscriptions/constants.ts";
import { sdkInstallDir } from "./copilot.ts";
import { ensurePrivateDir } from "./store.ts";

/**
 * The program and first arguments that run npm. On Windows npm is npm.cmd, which Node refuses to start without a shell
 * (CVE-2024-27980), so node runs npm's own script: the one beside this node, or beside the npm on PATH. Undefined when
 * Windows has no node or npm.
 */
export function npmCommand(
	platform: NodeJS.Platform = process.platform,
	execPath = process.execPath,
	path = process.env.PATH ?? "",
	exists: (file: string) => boolean = existsSync,
): { program: string; args: string[] } | undefined {
	if (platform !== "win32") return { program: "npm", args: [] };
	// Whole paths only: a relative entry would run a script from the current folder.
	const dirs = [win32.dirname(execPath), ...path.split(";").map((d) => d.replaceAll('"', ""))].filter((d) => win32.isAbsolute(d));
	const program = dirs.map((d) => win32.join(d, "node.exe")).find(exists);
	const script = dirs.map((d) => win32.join(d, "node_modules", "npm", "bin", "npm-cli.js")).find(exists);
	return program && script ? { program, args: [script] } : undefined;
}

export function installCopilotSdk(): { ok: boolean; message: string } {
	const npm = npmCommand();
	if (!npm) return { ok: false, message: "npm was not found. Install Node.js, which brings npm, then run this again." };
	const dir = sdkInstallDir();
	ensurePrivateDir(dir);
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "local-studio-copilot-sdk", private: true }, null, "\t")}\n`);
	const spec = `${COPILOT.sdkPackage}@${COPILOT.sdkVersion}`;
	const run = spawnSync(npm.program, [...npm.args, "install", "--prefix", dir, "--save-exact", "--no-audit", "--no-fund", spec], { stdio: "inherit" });
	if (run.status !== 0) return { ok: false, message: `npm install ${spec} failed (exit ${run.status ?? run.error?.message}).` };
	return { ok: true, message: `Installed ${spec} in ${dir}. Sign in with GitHub Copilot in Local Studio's settings.` };
}
