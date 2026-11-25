// sol-F3 (PR 3), on Windows: a running program locks the folder it was started from, so an upgrade that renames or
// deletes that folder fails while the browser runs the native host or an agent runs the MCP server. The installed
// local-studio-browser.exe here is a copy of node.exe (a real executable), started from the installed release and left running
// while a newer release is installed over it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const windows = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "local-studio-winup-"));
after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

// Windows' own bsdtar: Git for Windows puts GNU tar first on PATH, and it reads "C:\..." as a remote host.
const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const sha256 = (file) =>
	new Promise((resolve, reject) => {
		const h = createHash("sha256");
		createReadStream(file)
			.on("data", (d) => h.update(d))
			.on("end", () => resolve(h.digest("hex")))
			.on("error", reject);
	});

let n = 0;
/** A release folder with a local-studio-browser.exe that is node.exe, so it runs scripts from the working folder by name. */
async function makeRelease(version) {
	const dir = join(work, `release-${++n}`);
	const top = `local-studio-browser-${version}-win-${process.arch}`;
	const stage = join(dir, "stage", top);
	mkdirSync(join(stage, "extension"), { recursive: true });
	writeFileSync(join(stage, "extension", "manifest.json"), JSON.stringify({ name: "Local Studio", version }));
	copyFileSync(process.execPath, join(stage, "local-studio-browser.exe"));
	const archive = `${top}.tar.gz`;
	const packed = spawnSync(tar, ["-czf", join(dir, archive), "-C", join(dir, "stage"), top]);
	assert.equal(packed.status, 0, String(packed.stderr));
	rmSync(join(dir, "stage"), { recursive: true });
	const lines = [];
	for (const f of readdirSync(dir)) lines.push(`${await sha256(join(dir, f))}  ${f}\n`);
	writeFileSync(join(dir, "SHA256SUMS"), lines.join(""));
	return dir;
}

test("on Windows, an upgrade while local-studio-browser.exe runs from the installed release succeeds and keeps the running copy", { skip: !windows && "Windows only", timeout: 300_000 }, async () => {
	const home = join(work, "home");
	const local = join(home, "AppData", "Local");
	mkdirSync(local, { recursive: true });
	// The working folder holds the scripts the stand-in local-studio-browser.exe (node.exe) runs: `install` and `sleep`.
	const cwd = join(work, "cwd");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "install"), 'require("fs").writeFileSync(require("path").join(require("path").dirname(process.execPath), "ran-with"), "install");\n');
	writeFileSync(join(cwd, "sleep"), "setTimeout(() => {}, 600000);\n");
	const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(home, "AppData", "Roaming"), LOCAL_STUDIO_BROWSER_GH: "none" };
	const install = (dir) => {
		const r = spawnSync(process.execPath, [cli, "install", "--release", dir], { env, cwd, encoding: "utf8" });
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	};
	const first = install(await makeRelease("9.9.8"));
	assert.equal(first.status, 0, first.out);
	const release = join(local, "LocalStudioBrowser", "release");
	const sleeper = spawn(join(release, "local-studio-browser.exe"), ["sleep"], { cwd, stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(sleeper.exitCode, null, "the installed copy should still be running");
		const second = install(await makeRelease("9.9.9"));
		assert.equal(second.status, 0, second.out);
		assert.equal(JSON.parse(readFileSync(join(release, "extension", "manifest.json"), "utf8")).version, "9.9.9");
		assert.equal(readFileSync(join(release, "ran-with"), "utf8"), "install");
		const versions = join(local, "LocalStudioBrowser", "versions");
		assert.ok(readdirSync(versions).some((v) => v.startsWith("9.9.8")), "the running copy's folder was removed");
		sleeper.kill();
		await new Promise((r) => (sleeper.exitCode === null ? sleeper.once("exit", r) : r()));
		const third = install(await makeRelease("9.9.10"));
		assert.equal(third.status, 0, third.out);
		assert.equal(readdirSync(versions).some((v) => v.startsWith("9.9.8")), false, "the stopped old version was not removed");
		assert.ok(existsSync(join(release, "local-studio-browser.exe")));
	} finally {
		sleeper.kill();
	}
});
