// `local-studio-browser setup` and `local-studio-browser doctor` against a throwaway HOME, an empty socket
// directory, a fake extension build and a PATH holding only a node link plus fake
// harness CLIs. Nothing here can reach a real browser, bridge or harness config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const sourceVersion = JSON.parse(readFileSync(join(here, "..", "..", "static", "manifest.chrome.json"), "utf8")).version;
let root;
let home;
let bin;
let socketDir;
let extensionDir;
let harnessLog;

const helium = () =>
	process.platform === "darwin"
		? join(home, "Library", "Application Support", "net.imput.helium")
		: join(home, ".config", "net.imput.helium");
const launcher = () => join(home, ".local-studio", "browser", "local-studio-browser");

/**
 * A fake `claude` or `codex`. `mcp get` answers with an entry running `configured` (with
 * `args`, at `scope`) or exits 1 when there is none. Every call is logged.
 */
function fakeHarness(name, configured, { args = "mcp", scope = "User config (available in all your projects)" } = {}) {
	const file = join(bin, name);
	const get = configured
		? `if [ "$2" = "get" ]; then printf '  Scope: %s\\n  Command: %s\\n  Args: %s\\n  command: %s\\n  args: %s\\n' "${scope}" "${configured}" "${args}" "${configured}" "${args}"; exit 0; fi`
		: `if [ "$2" = "get" ]; then exit 1; fi`;
	writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${harnessLog}"\n${get}\nexit 0\n`);
	chmodSync(file, 0o755);
}

/** A loadable-looking build: the files `local-studio-browser` checks for, with a chosen version. */
function fakeBuild(version) {
	mkdirSync(extensionDir, { recursive: true });
	for (const f of ["background.js", "sidepanel.js", "sidepanel.html", "app.css"]) writeFileSync(join(extensionDir, f), "");
	writeFileSync(join(extensionDir, "manifest.json"), JSON.stringify({ name: "Local Studio", version }));
}

function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		env: {
			HOME: home,
			PATH: bin,
			LOCAL_STUDIO_BROWSER_SOCKET_DIR: socketDir,
			LOCAL_STUDIO_BROWSER_EXTENSION_DIR: extensionDir,
			// The browsers that count as installed here, not what this machine has.
			LOCAL_STUDIO_BROWSER_APPLICATIONS_DIRS: join(root, "apps"),
			TERM: "xterm-256color",
			...extraEnv,
		},
		input: "",
		timeout: 20000,
	});
	return { code: result.status, out: result.stdout + result.stderr };
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "local-studio-setup-"));
	home = join(root, "home");
	bin = join(root, "bin");
	socketDir = join(root, "sock");
	extensionDir = join(root, "dist-chrome");
	harnessLog = join(root, "harness.log");
	mkdirSync(home);
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "node"));
	mkdirSync(socketDir, { mode: 0o700 });
	mkdirSync(helium(), { recursive: true });
	mkdirSync(join(root, "apps", "Helium.app"), { recursive: true });
	writeFileSync(harnessLog, "");
	fakeBuild(sourceVersion);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("doctor fails with one fix per problem on a fresh machine", () => {
	const { code, out } = run(["doctor", "--json"]);
	assert.equal(code, 1);
	const report = JSON.parse(out);
	assert.equal(report.ok, false);
	const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
	assert.equal(byId.node.status, "ok");
	assert.equal(byId.build.status, "ok");
	assert.equal(byId["host:Helium"].status, "warn", "a browser never connected is news, not a failure");
	assert.equal(byId["host:Helium"].fix, "local-studio-browser install --browser Helium");
	assert.equal(byId.connected.status, "fail");
	for (const check of report.checks) if (check.status === "fail") assert.ok(check.fix, `${check.id} has no fix`);
});

test("doctor flags a build from another version of the checkout", () => {
	fakeBuild("0.0.1");
	try {
		const build = JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "build");
		assert.equal(build.status, "fail");
		assert.match(build.label, /does not match this checkout/);
		assert.equal(build.fix, "local-studio-browser setup");
	} finally {
		fakeBuild(sourceVersion);
	}
});

test("setup --yes registers the host, wires harnesses to the launcher, then shows the load step", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude");
	fakeHarness("codex");
	const { code, out } = run(["setup", "--yes", "--no-wait"]);
	// Not connected (no browser): setup says so and what to do next, and exits 0, since --no-wait skipped the wait.
	// `local-studio-browser update` runs exactly this, and an exit of 1 stopped it at step 12 of 15 with the rest not installed.
	assert.equal(code, 0, out);
	assert.match(out, /Not waiting \(--no-wait\)/);
	assert.match(out, /Almost there\. Load the extension/);
	assert.match(out, /Helium\s+registered/);
	assert.match(out, /Load unpacked/);
	assert.ok(out.includes(extensionDir), "prints the exact extension folder");
	assert.match(out, /Allow user scripts/);
	assert.ok(out.indexOf("Connect your coding agents") < out.indexOf("Load unpacked"), "agents are wired before the wait");

	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes(`claude mcp add --scope user local-studio -- ${launcher()} mcp`), calls);
	assert.ok(calls.includes(`codex mcp add local-studio -- ${launcher()} mcp`), calls);
	// The launcher pins node by absolute path, so GUI-started harnesses need no PATH.
	assert.match(readFileSync(launcher(), "utf8"), new RegExp(`exec "/[^"]+node" "${cli.replaceAll("/", "\\/")}" "\\$@"`));

	const doctor = JSON.parse(run(["doctor", "--json"]).out);
	assert.equal(doctor.checks.find((c) => c.id === "host:Helium").status, "ok");
});

test("an entry pointing at a missing command is stale, and setup replaces it", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", "/somewhere/gone/local-studio-browser");
	fakeHarness("codex", launcher());
	const checks = JSON.parse(run(["doctor", "--json"]).out).checks;
	const claude = checks.find((c) => c.id === "mcp:claude");
	assert.equal(claude.status, "fail");
	assert.match(claude.label, /missing command/);
	assert.match(claude.fix, /^claude mcp remove --scope user local-studio && claude mcp add/);
	assert.equal(checks.find((c) => c.id === "mcp:codex").status, "ok", "the launcher with args mcp is this CLI");

	run(["setup", "--yes", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes("claude mcp remove --scope user local-studio"), calls);
	assert.ok(!calls.includes("codex mcp add"), "a current entry is left alone");
});

test("another program's entry in a config setup only prints is named by its MCP server", () => {
	const file = join(home, ".cursor", "mcp.json");
	mkdirSync(join(home, ".cursor"));
	writeFileSync(file, JSON.stringify({ mcpServers: { "local-studio": { command: "/bin/sh", args: ["mcp"] } } }));
	try {
		const { out } = run(["setup", "--yes", "--no-wait"]);
		assert.ok(out.includes(`Cursor: replace the local-studio entry in ${file}`), out);
	} finally {
		rmSync(join(home, ".cursor"), { recursive: true });
	}
});

test("an entry running some other command is flagged but never replaced under --yes", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", "/bin/sh");
	fakeHarness("codex", launcher(), { args: "mcp --debug" });
	const checks = JSON.parse(run(["doctor", "--json"]).out).checks;
	assert.equal(checks.find((c) => c.id === "mcp:claude").status, "warn");
	assert.equal(checks.find((c) => c.id === "mcp:codex").status, "warn", "the launcher with other args is a customization, not breakage");

	const { out } = run(["setup", "--yes", "--no-wait"]);
	assert.match(out, /left alone/);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(!calls.includes("claude mcp remove") && !calls.includes("claude mcp add"), calls);
	assert.ok(!calls.includes("codex mcp remove") && !calls.includes("codex mcp add"), calls);
});

test("a Claude Code entry outside user scope is reported, and setup adds nothing over it", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", launcher(), { scope: "Local config (private to you in this project)" });
	const check = JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "mcp:claude");
	assert.equal(check.status, "warn");
	assert.match(check.detail, /Local config/);
	run(["setup", "--yes", "--no-wait"]);
	assert.ok(!readFileSync(harnessLog, "utf8").includes("claude mcp add"));
});

test("setup without --yes and without a terminal never edits a harness config", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude");
	run(["setup", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes("claude mcp get local-studio"), calls);
	assert.ok(!calls.includes("mcp add"), calls);
});

test("setup and doctor reject unknown flags and bad timeouts", () => {
	assert.equal(run(["doctor", "--jsno"]).code, 2);
	assert.equal(run(["setup", "--yse"]).code, 2);
	assert.equal(run(["setup", "--timeout=abc"]).code, 2);
	assert.equal(run(["setup", "--timeout", "0"]).code, 2);
});

test("allow and status validate their input before touching the bridge", () => {
	assert.equal(run(["allow", "not a host!"]).code, 2);
	assert.equal(run(["allow"]).code, 2);
	assert.equal(run(["status", "--jsno"]).code, 2);
	assert.equal(run(["allow", "com"]).code, 2, "a bare TLD is not a site");
	assert.equal(run(["allow", "localhost"]).code, 1, "localhost is a host; it fails only for lack of a browser");
	assert.equal(run(["status", "--help"]).code, 0);
	for (const args of [["ask", "github.com"], ["allow-all", "--force"], ["yolo", "x"], ["reload", "now"], ["install", "--yes"], ["allow", "a.com", "b.com"]]) {
		assert.equal(run(args).code, 2, `local-studio-browser ${args.join(" ")} should be a usage error`);
	}
	// A URL is reduced to its host; with no browser the command then fails with the next step.
	const { code, out } = run(["allow", "https://GitHub.com/baney75"]);
	assert.equal(code, 1);
	assert.match(out, /isn't connected/);
});

test("color only when asked for, and NO_COLOR wins", () => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
	const ansi = /\x1b\[/;
	assert.doesNotMatch(run(["doctor"]).out, ansi, "a pipe gets no color");
	assert.match(run(["doctor"], { FORCE_COLOR: "1" }).out, ansi);
	assert.doesNotMatch(run(["doctor"], { FORCE_COLOR: "1", NO_COLOR: "1" }).out, ansi);
});

test("second-S3: setup keeps a working launcher and writes links only for registered or chosen browsers", () => {
	// Helium is registered by the setup run above. Chrome has a data folder and (on a Mac) an app, and was never connected.
	const support = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google") : join(home, ".config");
	const chromeDir = process.platform === "darwin" ? join(support, "Chrome") : join(support, "google-chrome");
	mkdirSync(chromeDir, { recursive: true });
	mkdirSync(join(root, "apps", "Google Chrome.app"), { recursive: true });
	// A working standalone launcher: the agent launcher and the host launcher both exec a file that exists.
	const standalone = '#!/bin/sh\nexec "/bin/echo" "$@"\n';
	for (const name of ["local-studio-browser", "local-studio-browser-host"]) {
		writeFileSync(join(home, ".local-studio", "browser", name), standalone);
		chmodSync(join(home, ".local-studio", "browser", name), 0o755);
	}
	const heliumManifest = join(helium(), "NativeMessagingHosts", "com.localstudio.browser.json");
	const heliumBefore = readFileSync(heliumManifest, "utf8");
	const { out } = run(["setup", "--yes", "--no-wait"]);
	assert.match(out, /Helium\s+already registered/, out);
	assert.doesNotMatch(out, /Chrome\s+(registered|already)/, "setup does not touch a browser nobody registered or chose");
	assert.equal(existsSync(join(chromeDir, "NativeMessagingHosts", "com.localstudio.browser.json")), false, "no link for Chrome");
	assert.equal(readFileSync(join(home, ".local-studio", "browser", "local-studio-browser"), "utf8"), standalone, "the working launcher is kept");
	assert.equal(readFileSync(join(home, ".local-studio", "browser", "local-studio-browser-host"), "utf8"), standalone);
	assert.equal(readFileSync(heliumManifest, "utf8"), heliumBefore, "the registered browser's manifest is unchanged");
	// Choosing it makes the link, and still leaves the working launcher alone.
	const chosen = run(["setup", "--yes", "--no-wait", "--browser", "Chrome"]);
	assert.match(chosen.out, /Chrome\s+registered/, chosen.out);
	assert.equal(existsSync(join(chromeDir, "NativeMessagingHosts", "com.localstudio.browser.json")), true);
	assert.equal(readFileSync(join(home, ".local-studio", "browser", "local-studio-browser-host"), "utf8"), standalone);
	assert.equal(run(["setup", "--browser", "Netscape"]).code, 2, "an unknown browser is a usage error");
});

test("turning Claude Code's always-allow on takes a terminal", () => {
	fakeHarness("claude", launcher());
	const noTerminal = run(["claude-allow", "on"]);
	assert.notEqual(noTerminal.code, 0);
	assert.match(noTerminal.out, /takes a person/);
});

test("setup leaves permission rules for its own and other servers alone", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude", launcher());
	const settings = join(home, ".claude", "settings.json");
	mkdirSync(join(home, ".claude"), { recursive: true });
	const rules = { permissions: { deny: ["mcp__local-studio__run_js", "mcp__local-studio-work__run_js"] } };
	writeFileSync(settings, JSON.stringify(rules));
	try {
		run(["setup", "--yes", "--no-wait"]);
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), rules);
		assert.equal(JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "mcp:claude").status, "ok");
	} finally {
		rmSync(settings, { force: true });
	}
});

test("an entry that runs a launcher that is gone is rewritten to the current launcher", () => {
	writeFileSync(harnessLog, "");
	const old = join(home, "old-copy", "local-studio-browser");
	fakeHarness("claude", old);
	fakeHarness("codex", old);
	const claude = JSON.parse(run(["doctor", "--json"]).out).checks.find((c) => c.id === "mcp:claude");
	assert.equal(claude.status, "fail");
	assert.match(claude.label, /missing command/);

	run(["setup", "--yes", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	for (const [tool, add] of [
		["claude", `claude mcp add --scope user local-studio -- ${launcher()} mcp`],
		["codex", `codex mcp add local-studio -- ${launcher()} mcp`],
	]) {
		assert.ok(calls.includes(add), `${tool} points at the new launcher:\n${calls}`);
		assert.ok(calls.includes(`${tool} mcp remove`), `${tool}'s old entry is removed:\n${calls}`);
	}
	assert.ok(!calls.includes(`-- ${old} mcp`), "nothing is added that points at the old path");
});
