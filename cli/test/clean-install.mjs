// CI's clean-install job: install a packaged release into an empty home folder and reach the first page text. It fails when:
//   - the install, run from the unpacked archive, takes more than 60 s to the first get_page_text,
//   - a tampered artifact (an archive whose bytes no longer match SHA256SUMS) is accepted, or anything is written
//     for it, or
//   - with gh and a token at hand, a build with no attestation from a release workflow is accepted.
//   node cli/test/clean-install.mjs --release <folder from scripts/package-release.mjs>
// Linux only (the job runs on ubuntu). Needs Playwright's Chromium (`npx playwright-core install chromium`).
//
// Loading the extension (Developer mode and Load unpacked) is Chromium's --load-extension with the folder the installer
// printed. The page's site is allowed with `local-studio-browser allow`, the one-time approval a person gives on first use.
// LOCAL_STUDIO_BROWSER_GH=none stands for a computer without the GitHub CLI: pull request builds carry no attestation.
// LOCAL_STUDIO_BROWSER_SOCKET_DIR keeps the bridge socket inside the sandbox, so a helper already running on the machine is
// never reached.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeSync, closeSync, statSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };

const LIMIT_MS = 60_000;
const i = process.argv.indexOf("--release");
if (i < 0 || !process.argv[i + 1]) {
	console.error("usage: node cli/test/clean-install.mjs --release <folder>");
	process.exit(2);
}
const release = resolve(process.argv[i + 1]);
const log = (line) => console.log(`clean-install: ${line}`);

const artifacts = readdirSync(release).filter((f) => f === "SHA256SUMS" || /^local-studio-browser-.*-(linux-x64\.tar\.gz|extension\.zip)$/.test(f));
assert.ok(artifacts.includes("SHA256SUMS") && artifacts.some((f) => f.endsWith("linux-x64.tar.gz")), `no linux-x64 release in ${release}`);
const archive = artifacts.find((f) => f.endsWith("linux-x64.tar.gz"));
const top = archive.replace(/\.tar\.gz$/, "");
const command = `tar -xzf ${archive} && ./${top}/local-studio-browser install --release .`;

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "local-studio-clean-"));
// An empty home with a Chromium in it (its config folder exists, as it does once a browser has run), the release
// downloaded into ~/Downloads, and none of the runner's XDG folders.
function freshHome(name) {
	const home = join(scratch, name);
	mkdirSync(join(home, ".config", "chromium"), { recursive: true });
	const downloads = join(home, "Downloads");
	mkdirSync(downloads, { recursive: true });
	for (const f of artifacts) copyFileSync(join(release, f), join(downloads, f));
	const socketDir = mkdtempSync(join(scratch, "s"));
	const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TMPDIR: scratch, LOCAL_STUDIO_BROWSER_SOCKET_DIR: socketDir, LOCAL_STUDIO_BROWSER_GH: "none" };
	return { home, downloads, env };
}
const installed = (home) => join(home, ".local", "share", "local-studio-browser", "release");
const hostManifest = (home) => join(home, ".config", "chromium", "NativeMessagingHosts", "com.localstudio.browser.json");

async function until(fn, ms, what) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

let browser;
let mcp;
let server;
try {
	// 1. Tampered: one byte of the archive changed, SHA256SUMS as published. The program from a good copy must refuse
	// it and write nothing.
	{
		const t = freshHome("tampered");
		execFileSync("tar", ["-xzf", archive], { cwd: t.downloads });
		const bad = join(t.downloads, "bad");
		mkdirSync(bad);
		for (const f of artifacts) copyFileSync(join(t.downloads, f), join(bad, f));
		const file = join(bad, archive);
		const fd = openSync(file, "r+");
		const at = Math.floor(statSync(file).size / 2);
		const byte = Buffer.alloc(1);
		readSync(fd, byte, 0, 1, at);
		byte[0] ^= 0xff;
		writeSync(fd, byte, 0, 1, at);
		closeSync(fd);
		const r = spawnSync(join(t.downloads, top, "local-studio-browser"), ["install", "--release", bad], { cwd: bad, env: t.env, encoding: "utf8" });
		log(`tampered archive: exit ${r.status}`);
		assert.notEqual(r.status, 0, `a tampered archive was accepted:\n${r.stdout}${r.stderr}`);
		assert.match(`${r.stdout}${r.stderr}`, /does not match SHA256SUMS/);
		assert.equal(existsSync(installed(t.home)), false, "the tampered install unpacked something");
		assert.equal(existsSync(hostManifest(t.home)), false, "the tampered install registered a host");

		// With gh and a token (CI gives the job its token), a build no release workflow attested is refused too.
		const gh = spawnSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).stdout.trim();
		if (gh && process.env.GH_TOKEN) {
			const u = spawnSync(join(t.downloads, top, "local-studio-browser"), ["install", "--release", "."], {
				cwd: t.downloads,
				env: { ...t.env, LOCAL_STUDIO_BROWSER_GH: gh, GH_TOKEN: process.env.GH_TOKEN },
				encoding: "utf8",
			});
			log(`unattested build with gh: exit ${u.status}`);
			assert.notEqual(u.status, 0, `a build with no attestation was accepted:\n${u.stdout}${u.stderr}`);
			assert.match(`${u.stdout}${u.stderr}`, /attestation verify refused/);
			assert.equal(existsSync(installed(t.home)), false, "the unattested install unpacked something");
		} else log("unattested build: skipped (no gh or no GH_TOKEN)");
	}

	// 2. The install, timed to the first page text.
	const u = freshHome("user");
	server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><title>Clean install</title><p>Local Studio read this page after a clean install.</p>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const pageUrl = `http://127.0.0.1:${server.address().port}/`;
	const started = Date.now();
	const one = spawnSync("sh", ["-c", command], { cwd: u.downloads, env: u.env, encoding: "utf8" });
	log(`${command}: exit ${one.status}, ${Date.now() - started} ms`);
	assert.equal(one.status, 0, `${one.stdout}${one.stderr}`);
	assert.match(one.stdout, /matches SHA256SUMS/);
	assert.match(one.stdout, /Load the extension once/);
	const root = installed(u.home);
	const extension = join(dirname(root), "extension"); // the fixed folder next to release/, which outlives each version
	assert.ok(one.stdout.includes(extension), `the installer did not print the folder to load (${extension}):\n${one.stdout}`);
	const manifest = JSON.parse(readFileSync(hostManifest(u.home), "utf8"));
	assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId.id}/`]);
	// The host is the current version's program: each release install rewrites the manifest, and the pointer names the same file.
	assert.equal(realpathSync(manifest.path), realpathSync(join(root, "local-studio-browser")));

	// Load unpacked, pointed at the folder the installer printed.
	browser = spawn(
		chromium.executablePath(),
		[
			`--user-data-dir=${join(u.home, ".config", "chromium")}`,
			"--headless=new",
			"--no-first-run",
			"--no-default-browser-check",
			"--password-store=basic",
			"--disable-gpu",
			"--disable-breakpad",
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
			"about:blank",
		],
		{ env: u.env, stdio: ["ignore", "ignore", "pipe"] },
	);
	let chromiumLog = "";
	browser.stderr.on("data", (d) => {
		chromiumLog += d;
	});

	// The extension dials the host once it loads. Then first use: allow the page's site, and the first call.
	mcp = new Client({ name: "clean-install", version: "0.0.0" });
	await mcp.connect(new StdioClientTransport({ command: join(root, "local-studio-browser"), args: ["mcp"], env: { ...u.env, LOCAL_STUDIO_BROWSER_CLIENT_NAME: "clean-install", LOCAL_STUDIO_BROWSER_SESSION: "clean-install" }, stderr: "inherit" }));
	await until(
		async () => JSON.parse((await mcp.callTool({ name: "status", arguments: {} })).content.map((c) => c.text).join("")).connected,
		LIMIT_MS,
		"the extension to connect",
	).catch((err) => {
		throw new Error(`${err.message}\nChromium:\n${chromiumLog.slice(-2000)}`);
	});
	log(`extension connected after ${Date.now() - started} ms`);
	const allow = spawnSync(join(root, "local-studio-browser"), ["allow", "127.0.0.1"], { env: u.env, encoding: "utf8" });
	// It has failed with no output at all: name the signal or spawn error, not only the empty streams.
	assert.equal(
		allow.status,
		0,
		`local-studio-browser allow 127.0.0.1: status ${allow.status}, signal ${allow.signal}, error ${allow.error?.message}\n${allow.stdout}${allow.stderr}`,
	);
	const nav = await mcp.callTool({ name: "navigate", arguments: { url: pageUrl } });
	assert.ok(!nav.isError, `navigate: ${nav.content.map((c) => c.text).join("\n")}`);
	const text = (await mcp.callTool({ name: "get_page_text", arguments: {} })).content.map((c) => c.text).join("\n");
	const elapsed = Date.now() - started;
	assert.match(text, /Local Studio read this page after a clean install/);
	log(`first page text after ${elapsed} ms (limit ${LIMIT_MS} ms)`);
	assert.ok(elapsed <= LIMIT_MS, `the install took ${elapsed} ms; the limit is ${LIMIT_MS} ms`);
	log("passed");
} finally {
	await mcp?.close().catch(() => {});
	browser?.kill();
	server?.close();
	await new Promise((r) => setTimeout(r, 300));
	rmSync(scratch, { recursive: true, force: true });
}
