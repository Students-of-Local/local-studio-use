// Eukhe's mcpServers entry outlives the version folder it was written from: a release program under
// <base>/versions/<version>-<sha>/ is named through <base>/release, the pointer each install moves (review r2 first-F1).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stableReleaseProgram } from "../src/self.ts";

test("a program inside versions/ is named through the release pointer", () => {
	const base = join("/home", "u", ".local", "share", "local-studio-browser");
	assert.equal(stableReleaseProgram(join(base, "versions", "0.3.0-0123456789ab", "local-studio-browser")), join(base, "release", "local-studio-browser"));
	assert.equal(stableReleaseProgram(join(base, "versions", "0.3.0-0123456789ab", "local-studio-browser.exe")), join(base, "release", "local-studio-browser.exe"));
});

test("any other program path is kept", () => {
	for (const p of [join("/usr", "bin", "node"), join("/opt", "local-studio-browser", "release", "local-studio-browser"), join("/a", "versionsx", "v", "local-studio-browser")]) {
		assert.equal(stableReleaseProgram(p), p);
	}
});
