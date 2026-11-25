// The single-executable build (scripts/compile.mjs) run against a throwaway HOME. The first group builds the compiled-mode
// bundle and runs it under Node, so the compiled code paths are tested wherever Node is; the second compiles the real
// executable and is skipped when Bun is missing. Nothing here touches the real HOME, sockets or browsers.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
const EXTENSION_ID = extensionId.id;

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "local-studio-compiled-"));
after(() => rmSync(work, { recursive: true, force: true }));

const bundleDir = join(work, "bundle");
before(() => {
	execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: cliRoot, env: { ...process.env, LOCAL_STUDIO_BROWSER_CLI_COMPILED: "1", LOCAL_STUDIO_BROWSER_CLI_OUT_DIR: bundleDir }, stdio: "ignore" });
});

function sandbox(name) {
	const home = join(work, name);
	mkdirSync(join(home, "sock"), { recursive: true, mode: 0o700 });
	const env = { PATH: "/usr/bin:/bin", HOME: home, LOCAL_STUDIO_BROWSER_DIR: join(home, "local-studio-browser"), LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(home, "sock"), NO_COLOR: "1" };
	return { home, env };
}

test("the compiled-mode bundle knows it is compiled", () => {
	const text = readFileSync(join(bundleDir, "index.js"), "utf8");
	assert.doesNotMatch(text, /__LOCAL_STUDIO_BROWSER_COMPILED__/);
});

test("compiled-mode install points the browser at the helper itself and the agent launcher at the helper", () => {
	const { home, env } = sandbox("install");
	const chrome = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
	mkdirSync(chrome, { recursive: true });
	const out = execFileSync(process.execPath, [join(bundleDir, "index.js"), "install"], { env, encoding: "utf8" });
	assert.match(out, /Wrote/);
	const manifest = JSON.parse(readFileSync(join(chrome, "NativeMessagingHosts", "com.localstudio.browser.json"), "utf8"));
	assert.equal(manifest.path, process.execPath, "the manifest names the helper, not a script");
	assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
	for (const name of ["local-studio-browser", "local-studio-browser-host"]) {
		const text = readFileSync(join(env.LOCAL_STUDIO_BROWSER_DIR, name), "utf8");
		assert.equal(text.includes("node-compile-cache"), false);
		assert.match(text, new RegExp(`^#!/bin/sh\\nexec "${process.execPath.replaceAll("/", "\\/")}" ${name === "local-studio-browser-host" ? "host " : ""}"\\$@"\\n$`));
		assert.ok(statSync(join(env.LOCAL_STUDIO_BROWSER_DIR, name)).mode & 0o100, `${name} is executable`);
	}
	// A second run changes nothing: the manifest is current.
	assert.match(execFileSync(process.execPath, [join(bundleDir, "index.js"), "install"], { env, encoding: "utf8" }), /Current/);
});

test("compiled-mode update says Local Studio does it and changes nothing", () => {
	const { env } = sandbox("update");
	const out = execFileSync(process.execPath, [join(bundleDir, "index.js"), "update"], { env, encoding: "utf8" });
	assert.equal(out.replace(/^\S+ /, ""), "Local Studio updates this with the app.\n");
});

test("licenses.mjs --for extension lists the extension's packages, not the helper's", () => {
	const root = mkdtempSync(join(tmpdir(), "ext-licences-"));
	writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/lit": { version: "3.2.0", license: "BSD-3-Clause" }, "node_modules/vitest": { version: "1.0.0", dev: true } } }));
	mkdirSync(join(root, "node_modules", "lit"), { recursive: true });
	writeFileSync(join(root, "node_modules", "lit", "LICENSE"), "lit licence text");
	const out = join(root, "out.txt");
	execFileSync(process.execPath, ["scripts/licenses.mjs", "--out", out, "--for", "extension", "--root", root], { cwd: cliRoot, stdio: "ignore" });
	const text = readFileSync(out, "utf8");
	assert.match(text, /^Local Studio's browser extension is Local Studio/);
	assert.match(text, /lit 3\.2\.0 \(BSD-3-Clause\)\n=+\nlit licence text/);
	assert.doesNotMatch(text, /vitest/, "a dev package isn't shipped");
});

test("compiled-mode update --host answers the side panel with one failed step that says the app updates it", () => {
	const { env } = sandbox("update-host");
	for (const args of [["update", "--host"], ["update", "--host", "--reinstall"]]) {
		const r = spawnSync(process.execPath, [join(bundleDir, "index.js"), ...args], { env, encoding: "utf8" });
		const lines = r.stdout.trim().split("\n");
		assert.equal(lines.length, 1, r.stdout);
		const step = JSON.parse(lines[0]);
		assert.equal(step.phase, "failed", r.stdout);
		assert.equal(step.message, "Local Studio updates this with the app.");
		assert.equal(r.status, 1);
	}
});

test("compiled mode takes the helper in its own folder, and none from PATH or ~/.local/bin", () => {
	const { home, env } = sandbox("beside");
	const helper = (dir) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "local-studio-computer"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		return join(dir, "local-studio-computer");
	};
	// Compiled mode names itself by process.execPath, so a copy of node in a folder of its own stands in for the program.
	const program = join(home, "app", "local-studio-browser");
	mkdirSync(dirname(program));
	copyFileSync(process.execPath, program);
	const found = () => JSON.parse(spawnSync(program, [join(bundleDir, "index.js"), "status", "--json"], { env: { ...env, PATH: `${join(home, "path")}:/usr/bin:/bin` }, encoding: "utf8" }).stdout).computer.helper;
	helper(join(home, "path"));
	helper(join(home, ".local", "bin"));
	assert.equal(found(), null);
	const inBin = helper(join(home, "app", "bin"));
	assert.equal(found(), inBin);
	const beside = helper(join(home, "app"));
	assert.equal(found(), beside);
});

test("a compiled copy inside the app registers no browser by itself when its MCP server starts", () => {
	const { home, env } = sandbox("app-mcp");
	const chrome = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
	mkdirSync(chrome, { recursive: true });
	const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
	const r = spawnSync(process.execPath, [join(bundleDir, "index.js"), "mcp", "--tools", "browser"], { env, encoding: "utf8", input: `${JSON.stringify(initialize)}\n`, timeout: 15_000 });
	assert.match(r.stdout, /"serverInfo":\{"name":"local-studio"/);
	assert.equal(existsSync(join(chrome, "NativeMessagingHosts")), false);
	assert.equal(existsSync(env.LOCAL_STUDIO_BROWSER_DIR), false, "no launchers either");
});

test("compiled-mode install --remove takes back the manifest that names this program", () => {
	const { home, env } = sandbox("remove");
	const chrome = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
	mkdirSync(chrome, { recursive: true });
	const cli = (...args) => execFileSync(process.execPath, [join(bundleDir, "index.js"), ...args], { env, encoding: "utf8" });
	const file = join(chrome, "NativeMessagingHosts", "com.localstudio.browser.json");
	cli("install", "--browser", "Chrome");
	assert.ok(existsSync(file));
	assert.match(cli("install", "--remove"), /Removed/);
	assert.equal(existsSync(file), false);
	const other = JSON.stringify({ name: "com.localstudio.browser", path: "/bin/ls" });
	writeFileSync(file, other);
	assert.match(cli("install", "--remove"), /Left alone/);
	assert.equal(readFileSync(file, "utf8"), other);
});

// ---- the real executable ----

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const haveBun = bun.status === 0;
const exe = join(work, "local-studio-browser");

test("the real executable builds, reports a version and lists the same tools", { skip: !haveBun && "bun is not installed" }, async () => {
	execFileSync(process.execPath, ["scripts/compile.mjs", "--arch", process.arch === "arm64" ? "arm64" : "x64", "--out", exe], { cwd: cliRoot, stdio: "ignore" });
	const { env } = sandbox("exe");
	const version = execFileSync(exe, ["--version"], { env, encoding: "utf8" }).trim();
	const manifest = JSON.parse(readFileSync(join(cliRoot, "..", "static", "manifest.chrome.json"), "utf8"));
	assert.equal(version, manifest.version);
	const tools = await new Promise((resolve, reject) => {
		const child = spawn(exe, ["mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (const line of buf.split("\n")) {
				try {
					const m = JSON.parse(line);
					if (m.id === 2) {
						child.kill();
						resolve(m.result.tools.map((t) => t.name));
					}
				} catch {
					/* partial line */
				}
			}
		});
		child.on("error", reject);
		const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
		send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
		send({ method: "notifications/initialized" });
		send({ id: 2, method: "tools/list" });
	});
	for (const name of ["tabs_context", "navigate", "read_page", "skill_search", "library_add"]) assert.ok(tools.includes(name), `${name} is listed`);
});

test("the real executable treats a chrome-extension argument as the native host", { skip: !haveBun && "bun is not installed" }, () => {
	const { env } = sandbox("host");
	// Native messaging: 4-byte length, then JSON. End of input ends the host without a browser attached.
	const r = spawnSync(exe, [`chrome-extension://${EXTENSION_ID}/`], { env, input: Buffer.alloc(0), timeout: 15000 });
	assert.notEqual(r.signal, "SIGTERM", "the host ended on its own when input closed");
	assert.doesNotMatch(String(r.stderr), /Unknown command|Usage/);
});

test("the real executable keeps its data in ~/.local-studio/browser", { skip: !haveBun && "bun is not installed" }, () => {
	const { home, env } = sandbox("config");
	delete env.LOCAL_STUDIO_BROWSER_DIR;
	const dir = join(home, ".local-studio", "browser");
	mkdirSync(join(dir, "library"), { recursive: true });
	const saved = JSON.stringify({ preset: "forest" });
	writeFileSync(join(dir, "theme.json"), saved);
	writeFileSync(join(dir, "library", "keep.txt"), "kept");
	const out = JSON.parse(execFileSync(exe, ["theme", "--json"], { env, encoding: "utf8" }));
	assert.equal(out.preset, "forest", "the saved choice was read from where it already was");
	assert.equal(readFileSync(join(dir, "theme.json"), "utf8"), saved);
	assert.equal(readFileSync(join(dir, "library", "keep.txt"), "utf8"), "kept");
	assert.equal(existsSync(join(home, ".config", "local-studio-browser")), false, "no second config folder was made");
});
