// No file of this folder, its name, the files this folder adds elsewhere in the repository or the built output holds a name
// this code had before. The names are written here in pieces, so this file is scanned too.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const FORMER = new RegExp([["tychi", "cus"], ["poly", "carp"], ["tab", "kyra"], ["baney", "spaces"]].map((p) => p.join("")).join("|"), "i");
/** Outside this folder: its workflows, its issue forms and its funding and owners lines. */
const OUTSIDE = [":(top).github"];

const tracked = (...paths) => execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
/** Every way the name could be there: bytes read as Latin-1 never hide an ASCII name. */
const holds = (file) => FORMER.test(readFileSync(file, "latin1"));

test("no tracked file or path holds a former name", () => {
	const files = [...tracked("."), ...tracked(...OUTSIDE)].filter((f) => existsSync(join(root, f)));
	assert.ok(files.length > 500, `read ${files.length} files`);
	assert.deepEqual(files.filter((f) => FORMER.test(f)), [], "paths");
	assert.deepEqual(files.filter((f) => holds(join(root, f))), [], "contents");
});

test("no built file holds a former name, source maps included", (t) => {
	const built = ["dist-chrome", "cli/dist"].map((d) => join(root, d)).filter((d) => existsSync(d));
	if (!built.length) return t.skip("nothing is built");
	const files = built.flatMap((d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)));
	assert.deepEqual(files.filter((f) => FORMER.test(f.slice(repo.length)) || holds(f)), []);
});

test("the scan catches a name in any case", () => {
	for (const name of [["Tychi", "cus"], ["POLY", "CARP"], ["x-tab", "kyra-hub"]]) assert.match(name.join(""), FORMER);
	assert.doesNotMatch("Local Studio local-studio-browser", FORMER);
});

test("the product is Local Studio where a person reads it", () => {
	const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
	assert.equal(manifest.name, "Local Studio");
	assert.equal(manifest.action.default_title.startsWith("Local Studio") || /Local Studio/.test(manifest.action.default_title), true);
	assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name, "local-studio-browser");
	assert.equal(JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8")).name, "local-studio-browser");
});
