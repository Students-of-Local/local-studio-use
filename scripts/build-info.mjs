// What a build was made from: written as build-info.json next to each build and compiled into
// the bundle as __LOCAL_STUDIO_BROWSER_BUILD__. The update system compares the running extension, the native
// host and the files on disk with it (docs/updates.md, "Version mismatch").
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** id is new for every build; commit and version say what it was built from. */
export function buildInfo(repo) {
	const git = (args, env = process.env) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
	let commit = "";
	let commitDate = "";
	let dirty = false;
	try {
		commit = git(["rev-parse", "HEAD"]);
		// The same shape the app's Info.plist and the local-studio-browser command carry, so the three compare.
		commitDate = git(["log", "-1", "--format=%cd", "--date=format-local:%Y-%m-%dT%H:%M:%SZ"], {
			...process.env,
			TZ: "UTC",
		});
		// Tracked files of the whole checkout: build output and the sibling checkouts are untracked or ignored.
		dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
	} catch {
		// Not a git checkout (an unpacked source archive): the version still identifies it.
	}
	const version = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8")).version;
	return { id: randomUUID(), commit, commitDate, dirty, version, builtAt: new Date().toISOString() };
}

// `node scripts/build-info.mjs` prints what a build made now would record, so a release check can read "dirty".
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.log(JSON.stringify(buildInfo(join(dirname(fileURLToPath(import.meta.url)), "..")), null, "\t"));
}
