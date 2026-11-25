// The command names in printed text. Every string a person reads is built from the name the helper was started as
// (COMMAND_NAME in the CLI, hostCommand() in the extension); a plain "..." string that holds ${COMMAND_NAME} prints it
// literally, so none may exist, and the one case that did is rendered here.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");

function* sources(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sources(path);
		else if (path.endsWith(".ts")) yield path;
	}
}

test("no quoted string holds an unexpanded ${COMMAND_NAME} or ${hostCommand()}", () => {
	const bad = [];
	for (const file of [...sources(join(here, "..", "src")), ...sources(join(here, "..", "..", "src"))]) {
		const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		(function visit(node) {
			// A quoted string ("..." or '...') never expands ${...}; a template literal (backticks) does.
			if (ts.isStringLiteral(node) && /\$\{\s*(?:COMMAND_NAME|hostCommand\(\))/.test(node.text)) {
				bad.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
			}
			ts.forEachChild(node, visit);
		})(sf);
	}
	assert.deepEqual(bad, []);
});

const home = mkdtempSync(join(tmpdir(), "local-studio-names-"));
after(() => rm(home, { recursive: true, force: true }));

test("a Cloudflare tunnel that is already running names the command to stop it, not ${COMMAND_NAME}", async () => {
	// A stand-in with the command line the tunnel check looks for.
	const stand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "cloudflared", "tunnel", "--url", "http://127.0.0.1:9"], { stdio: "ignore" });
	try {
		mkdirSync(join(home, ".local-studio", "browser"), { recursive: true });
		writeFileSync(join(home, ".local-studio", "browser", "cloudflared.pid"), String(stand.pid));
		const r = await new Promise((resolve) => {
			const child = spawn(process.execPath, [cli, "tunnel", "cloudflare"], { env: { PATH: "/usr/bin:/bin", HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			child.on("close", () => resolve(out));
		});
		assert.match(r, /A Cloudflare tunnel is already running\. Run local-studio-browser tunnel cloudflare --off first\./);
		assert.doesNotMatch(r, /\$\{/);
	} finally {
		stand.kill();
	}
});

test("the host does not ask the system for its parent browser until it runs as the native host", () => {
	const text = readFileSync(join(here, "..", "src", "host.ts"), "utf8");
	assert.doesNotMatch(text, /^const browserName = parentBrowserName\(\)/m, "a top-level call would run `ps` for every command, --version included");
	// The caller check comes first (no frame is read for another extension), then the parent browser, still inside.
	assert.match(text, /export function runNativeHost\(args: readonly string\[\] = \[\]\): void \{\n\tconst refusal = callerRefusal\(args\);\n\tif \(refusal\) \{\n[\s\S]*?\n\t\}\n\tbrowserName = parentBrowserName\(\);/);
	const r = spawnSync(process.execPath, [cli, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: home, LOCAL_STUDIO_BROWSER_PARENT_BROWSER: "" }, encoding: "utf8" });
	assert.equal(r.status, 0);
});

