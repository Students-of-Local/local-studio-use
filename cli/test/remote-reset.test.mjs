// `remote reset --new-passcode-file`: after a tunnel token leaked, a new passcode from an owner-only file, and every grant,
// client registration, connect code and static token ended and read back. A real serve with OAuth on runs in a temp HOME and
// config folder; the grant is made through the real register, approve and token endpoints. Nothing here reads or writes
// ~/.local-studio/browser or starts a service.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "local-studio-reset-"));
after(() => rmSync(root, { recursive: true, force: true }));
const nodeOnly = join(root, "node-path");
mkdirSync(nodeOnly, { recursive: true });
symlinkSync(process.execPath, join(nodeOnly, "node"));
const posix = process.platform !== "win32";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const { passcodeMatches } = await loadTs(`export { passcodeMatches } from "@src/oauth.ts";`);

/** A HOME and config folder of its own, and a runner for the CLI in them. */
function machine(name) {
	const home = join(root, name);
	const config = join(home, "cfg");
	mkdirSync(config, { recursive: true, mode: 0o700 });
	const env = { HOME: home, LOCAL_STUDIO_BROWSER_DIR: config, PATH: nodeOnly, NO_COLOR: "1", LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(home, "sock"), LOCAL_STUDIO_BROWSER_APPLICATIONS_DIR: join(home, "apps"), LOCAL_STUDIO_BROWSER_DOH_URL: "http://127.0.0.1:9/dns-query" };
	/** `extra` env on top of this machine's, and `input` on stdin (a pipe: no terminal unless LOCAL_STUDIO_BROWSER_ASSUME_TTY says so). */
	const run = (args, { extra = {}, input } = {}) => {
		const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
		return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
	};
	/** A passcode file with `text` and `mode`. */
	const file = (fileName, text, mode = 0o600) => {
		const path = join(home, fileName);
		writeFileSync(path, text);
		chmodSync(path, mode);
		return path;
	};
	return { home, config, env, run, file };
}

/** passcodeMatches against this machine's oauth.json. */
function matches(m, passcode) {
	const was = process.env.LOCAL_STUDIO_BROWSER_DIR;
	process.env.LOCAL_STUDIO_BROWSER_DIR = m.config;
	try {
		return passcodeMatches(passcode);
	} finally {
		if (was === undefined) delete process.env.LOCAL_STUDIO_BROWSER_DIR;
		else process.env.LOCAL_STUDIO_BROWSER_DIR = was;
	}
}

const NEW_PASSCODE = "correct-horse-battery-staple-42";

(posix ? test : test.skip)("remote reset refuses a passcode file others can read or write, an empty or short one, and a link, and changes nothing", () => {
	const m = machine("refusals");
	const old = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/.exec(m.run(["token", "passcode"]).out)?.[0];
	assert.ok(old);
	const before = readFileSync(join(m.config, "oauth.json"), "utf8");
	const cases = [
		["group readable", m.file("group", `${NEW_PASSCODE}\n`, 0o640), /can be read or written by others \(mode 0640\).*chmod 600/],
		["world readable", m.file("world", `${NEW_PASSCODE}\n`, 0o604), /can be read or written by others \(mode 0604\)/],
		["group writable", m.file("gw", `${NEW_PASSCODE}\n`, 0o620), /can be read or written by others/],
		["empty", m.file("empty", "", 0o600), /can't be used: it is empty/],
		["only a newline", m.file("newline", "\n", 0o600), /can't be used: it is empty/],
		["shorter than 20", m.file("short", "nineteen-characters\n", 0o600), /it is 19 characters; a passcode needs at least 20/],
		["two lines", m.file("lines", `${NEW_PASSCODE}\nsecond-line-of-text\n`, 0o600), /control character or a second line/],
		["missing", join(m.home, "nope"), /doesn't exist/],
	];
	const link = join(m.home, "link");
	symlinkSync(m.file("target", `${NEW_PASSCODE}\n`, 0o600), link);
	cases.push(["symbolic link", link, /symbolic link/]);
	for (const [what, path, pattern] of cases) {
		const r = m.run(["remote", "reset", "--new-passcode-file", path, "--json"]);
		assert.equal(r.code, 2, `${what}: ${r.out}`);
		const report = JSON.parse(r.stdout);
		assert.equal(report.ok, false, what);
		assert.equal(report.code, "passcode_file", what);
		assert.match(report.message, pattern, what);
		assert.match(report.message, /Nothing was changed/, what);
		assert.ok(!r.out.includes(NEW_PASSCODE), `${what}: the passcode is never printed`);
		// The file is checked before anything asks for a yes; a file others can read gets the command that fixes it.
		if (what === "group readable") assert.deepEqual(report.next, { kind: "run_command", command: `chmod 600 ${path}` });
	}
	// No flag, and the flag with no value, are usage errors.
	assert.equal(m.run(["remote", "reset"]).code, 2);
	assert.equal(m.run(["remote", "reset", "--new-passcode-file"]).code, 2);
	assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), before, "a refused reset changes nothing");
	assert.ok(matches(m, old), "the old passcode still stands");
});

const freePort = () =>
	new Promise((resolve) => {
		const s = createNetServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reset-test", version: "0" } } };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

(posix ? test : test.skip)("after remote reset, a grant and client made through the real OAuth flow are dead, their sessions close, the passcode changed, and exit is 0", async () => {
	const m = machine("flow");
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const oldPasscode = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/.exec(m.run(["token", "passcode"]).out)?.[0];
	assert.ok(oldPasscode);
	const staticToken = /tkr_[A-Za-z0-9_-]+/.exec(m.run(["token", "create", "agent", "--scope", "skills.read"]).out)?.[0];
	assert.ok(staticToken);
	const srv = spawn(process.execPath, [cli, "serve", "--port", String(port), "--public-url", base], { env: m.env });
	const streams = [];
	try {
		await new Promise((resolve, reject) => {
			let out = "";
			srv.stdout.on("data", (d) => {
				out += d;
				if (/OAuth on/.test(out)) resolve();
			});
			srv.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
			setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
		});
		const callback = "https://claude.ai/api/mcp/auth_callback";
		const reg = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [callback] }) });
		assert.equal(reg.status, 201);
		const { client_id } = await reg.json();
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${base}/mcp` });
		const approve = async (passcode) => {
			const page = await (await fetch(`${base}/authorize?${q}`)).text();
			const signed = /name="request" value="([^"]+)"/.exec(page)?.[1];
			return fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([["request", signed], ["passcode", passcode], ["scope", "skills.read"], ["decision", "allow"]]) });
		};
		const codeOf = (res) => new URL(res.headers.get("location")).searchParams.get("code");
		const mint = () => /TK-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(m.run(["token", "approval-code"]).out)?.[0];
		const token = (fields) => fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

		// The grant, through the real endpoints: a connect code approves the new client, then the code is exchanged.
		const first = await approve(mint());
		assert.equal(first.status, 302);
		const grant = await (await token({ grant_type: "authorization_code", code: codeOf(first), client_id, redirect_uri: callback, code_verifier: verifier })).json();
		assert.match(grant.access_token, /^tko_/);
		assert.match(grant.refresh_token, /^tkf_/);
		// A second code, approved with the old passcode (the client is approved now) and not yet exchanged: it lives in serve's memory.
		const pending = await approve(oldPasscode);
		assert.equal(pending.status, 302);
		const pendingCode = codeOf(pending);
		// A connect code minted and never used.
		assert.ok(mint());

		// Sessions open before the reset: an OAuth one and a static token's, each holding a stream open.
		const open = async (bearer) => {
			const init = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${bearer}` }, body: JSON.stringify(INIT) });
			assert.equal(init.status, 200);
			const session = init.headers.get("mcp-session-id");
			await init.body?.cancel();
			const headers = { authorization: `Bearer ${bearer}`, "mcp-session-id": session };
			const ack = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
			assert.equal(ack.status, 202);
			const stream = await fetch(`${base}/mcp`, { method: "GET", headers: { accept: "text/event-stream", ...headers } });
			assert.equal(stream.status, 200);
			const reader = stream.body.getReader();
			streams.push(reader);
			// Resolves when serve ends the stream.
			const ended = (async () => {
				for (;;) if ((await reader.read()).done) return true;
			})();
			return { session, ended };
		};
		const oauthSession = await open(grant.access_token);
		const staticSession = await open(staticToken);

		const file = m.file("new-passcode", `${NEW_PASSCODE}\n`, 0o600);
		const r = m.run(["remote", "reset", "--new-passcode-file", file, "--yes", "--json"]);
		assert.equal(r.code, 0, r.out);
		const report = JSON.parse(r.stdout);
		assert.equal(report.ok, true, r.stdout);
		assert.equal(report.state, "done");
		assert.deepEqual(report.next, { kind: "run_command", command: "local-studio-browser token approval-code --json" }, "an agent knows to make a connect code");
		assert.deepEqual(report.ended, { clients: 1, grants: 1, approvalCodes: 1, deviceCodes: 0, staticRevoked: 1, devices: [] });
		assert.deepEqual(report.left, []);
		assert.ok(!r.out.includes(NEW_PASSCODE) && !r.out.includes(oldPasscode), "no passcode is printed");

		// The read-back, by hand: oauth.json holds no client and no token, no connect code is live, the static token is revoked.
		const state = JSON.parse(readFileSync(join(m.config, "oauth.json"), "utf8"));
		assert.deepEqual([Object.keys(state.clients).length, Object.keys(state.tokens).length], [0, 0]);
		const codes = JSON.parse(readFileSync(join(m.config, "oauth-codes.json"), "utf8")).codes;
		assert.deepEqual(codes, []);
		assert.ok(JSON.parse(readFileSync(join(m.config, "tokens.json"), "utf8")).tokens.every((t) => t.revokedAt));

		// Open sessions end without another request: their streams close within a few seconds.
		const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(false), ms));
		assert.equal(await Promise.race([oauthSession.ended, timeout(8000)]), true, "the OAuth session's stream was closed");
		assert.equal(await Promise.race([staticSession.ended, timeout(8000)]), true, "the static token's session stream was closed");

		// The old access token, refresh token and pending code all fail.
		const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${grant.access_token}` }, body: JSON.stringify(INIT) });
		assert.equal(mcp.status, 401, "an /mcp call with the old access token is refused");
		const onSession = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${grant.access_token}`, "mcp-session-id": oauthSession.session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
		assert.equal(onSession.status, 401, "and on its old session");
		const viaStatic = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${staticToken}` }, body: JSON.stringify(INIT) });
		assert.equal(viaStatic.status, 401, "the static token is revoked");
		const refreshed = await token({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id });
		assert.ok(refreshed.status >= 400 && refreshed.status < 500, `a token request with the old refresh token fails (${refreshed.status})`);
		assert.equal((await refreshed.json()).access_token, undefined, "no new token");
		const exchanged = await token({ grant_type: "authorization_code", code: pendingCode, client_id, redirect_uri: callback, code_verifier: verifier });
		assert.ok(exchanged.status >= 400 && exchanged.status < 500, `the code issued before the reset is refused (${exchanged.status})`);
		const consent = await fetch(`${base}/authorize?${q}`);
		assert.equal(consent.status, 400, "the old client registration is gone");

		// The passcode changed: a client registered and approved after the reset takes the new passcode and refuses the old one.
		assert.equal(matches(m, NEW_PASSCODE), true);
		assert.equal(matches(m, oldPasscode), false);
		const again = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [callback] }) });
		const fresh = (await again.json()).client_id;
		q.set("client_id", fresh);
		assert.equal((await approve(mint())).status, 302, "a new connect code approves the new client");
		const oldTry = await approve(oldPasscode);
		assert.equal(oldTry.status, 401, "the old passcode no longer approves");
		assert.match(await oldTry.text(), /Wrong passcode/);
		assert.equal((await approve(NEW_PASSCODE)).status, 302, "the new passcode does");
	} finally {
		for (const reader of streams) await reader.cancel().catch(() => {});
		srv.kill();
	}
});

(posix ? test : test.skip)("remote reset exits 1 and names what is left when a step fails, after doing the rest", () => {
	const m = machine("partial");
	m.run(["token", "passcode"]);
	assert.equal(m.run(["token", "approval-code"]).code, 0);
	// tokens.json that can't be parsed: the static token step fails, and the read-back can't prove it either.
	writeFileSync(join(m.config, "tokens.json"), "not json");
	const p = m.file("p", NEW_PASSCODE, 0o600);
	const r = m.run(["remote", "reset", "--new-passcode-file", p, "--yes", "--json"]);
	assert.equal(r.code, 1, r.out);
	const report = JSON.parse(r.stdout);
	assert.equal(report.ok, false);
	assert.equal(report.state, "failed");
	assert.deepEqual(report.next, { kind: "run_command", command: `local-studio-browser remote reset --new-passcode-file ${p} --yes --json` }, "the same reset again");
	assert.deepEqual(report.failed.map((f) => f.step), ["static_tokens"]);
	assert.deepEqual(report.left.map((l) => l.name), ["static_tokens"]);
	assert.match(report.message, /Reset isn't complete: static_tokens failed/);
	assert.match(report.message, /remote reset again before the tunnel comes back/);
	// The other steps ran: the passcode is the new one and no connect code is live.
	assert.equal(matches(m, NEW_PASSCODE), true);
	assert.deepEqual(JSON.parse(readFileSync(join(m.config, "oauth-codes.json"), "utf8")).codes, []);
	// Text mode says the same on stderr and exits 1.
	const text = m.run(["remote", "reset", "--new-passcode-file", m.file("p2", NEW_PASSCODE, 0o600), "--yes"]);
	assert.equal(text.code, 1);
	assert.match(text.out, /Reset isn't complete/);
});

(posix ? test : test.skip)("remote reset keeps link tokens, which no public route accepts, and refuses a shell whose config folder isn't the service's", () => {
	const m = machine("folders");
	m.run(["token", "passcode"]);
	writeFileSync(join(m.config, "tokens.json"), JSON.stringify({ tokens: [{ id: "abcdef01", name: "link:run", scopes: ["browser.read"], sha256: "00".repeat(32), createdAt: new Date().toISOString(), kind: "link" }] }));
	const ok = m.run(["remote", "reset", "--new-passcode-file", m.file("p", NEW_PASSCODE, 0o600), "--yes", "--json"]);
	assert.equal(ok.code, 0, ok.out);
	assert.deepEqual(JSON.parse(ok.stdout).kept, { linkTokens: 1 });
	assert.equal(JSON.parse(readFileSync(join(m.config, "tokens.json"), "utf8")).tokens[0].revokedAt, undefined);

	// A serve service set up with its own config folder: resetting this shell's folder would leave its grants working.
	const other = join(m.home, "Service Config");
	const serviceFile = process.platform === "darwin" ? join(m.home, "Library", "LaunchAgents", "com.localstudio.browser.serve.plist") : join(m.home, ".config", "systemd", "user", "local-studio-browser-serve.service");
	mkdirSync(dirname(serviceFile), { recursive: true });
	writeFileSync(
		serviceFile,
		process.platform === "darwin"
			? `<plist><dict><key>EnvironmentVariables</key><dict><key>LOCAL_STUDIO_BROWSER_DIR</key><string>${other}</string></dict></dict></plist>\n`
			: `[Service]\nEnvironment="LOCAL_STUDIO_BROWSER_DIR=${other}"\n`,
	);
	const before = readFileSync(join(m.config, "oauth.json"), "utf8");
	const p2 = m.file("p2", `${NEW_PASSCODE}-2`, 0o600);
	const refused = m.run(["remote", "reset", "--new-passcode-file", p2, "--yes", "--json"]);
	assert.equal(refused.code, 2, refused.out);
	const report = JSON.parse(refused.stdout);
	assert.equal(report.code, "config_folder");
	assert.deepEqual(report.next, { kind: "run_command", command: `LOCAL_STUDIO_BROWSER_DIR='${other}' local-studio-browser remote reset --new-passcode-file ${p2} --yes --json` });
	assert.ok(report.message.includes(other), report.message);
	assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), before);
	assert.ok(!existsSync(join(other, "oauth.json")));
});

(posix ? test : test.skip)("remote reset never asks without a terminal or with --json: it needs --yes; at a terminal it asks first", () => {
	const m = machine("confirm");
	const old = /([a-zA-Z0-9]{5}-){3}[a-zA-Z0-9]{5}/.exec(m.run(["token", "passcode"]).out)?.[0];
	const before = readFileSync(join(m.config, "oauth.json"), "utf8");
	const p = m.file("p", `${NEW_PASSCODE}\n`, 0o600);
	const unchanged = (what) => {
		assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), before, `${what}: nothing changed`);
		assert.ok(matches(m, old), `${what}: the old passcode stands`);
	};

	// No terminal (stdin is a pipe), no --yes: refused with a code and the command to run, without waiting on stdin.
	const agent = m.run(["remote", "reset", "--new-passcode-file", p, "--json"], { input: "y\n" });
	assert.equal(agent.code, 2, agent.out);
	const report = JSON.parse(agent.stdout);
	assert.deepEqual([report.ok, report.state, report.code], [false, "refused", "confirmation_required"]);
	assert.deepEqual(report.next, { kind: "run_command", command: `local-studio-browser remote reset --new-passcode-file ${p} --yes --json` });
	unchanged("no terminal, --json");
	const plain = m.run(["remote", "reset", "--new-passcode-file", p]);
	assert.equal(plain.code, 2, plain.out);
	assert.match(plain.out, /needs a yes\. Run it in a terminal, or add --yes/);
	unchanged("no terminal, text");
	// --json never asks, even at a terminal: an agent reads that output.
	const tty = { LOCAL_STUDIO_BROWSER_ASSUME_TTY: "1" };
	const jsonAtTerminal = m.run(["remote", "reset", "--new-passcode-file", p, "--json"], { extra: tty, input: "y\n" });
	assert.equal(jsonAtTerminal.code, 2, jsonAtTerminal.out);
	assert.equal(JSON.parse(jsonAtTerminal.stdout).code, "confirmation_required");
	unchanged("--json at a terminal");

	// At a terminal it asks; anything but yes changes nothing.
	const no = m.run(["remote", "reset", "--new-passcode-file", p], { extra: tty, input: "n\n" });
	assert.equal(no.code, 2, no.out);
	assert.match(no.out, /Every assistant must connect again\. \[y\/N\]/);
	assert.match(no.out, /Stopped: you said no\. Nothing was changed\./);
	unchanged("answered no");
	const yes = m.run(["remote", "reset", "--new-passcode-file", p], { extra: tty, input: "yes\n" });
	assert.equal(yes.code, 0, yes.out);
	assert.match(yes.out, /Connect each assistant again: local-studio-browser token approval-code/);
	assert.ok(matches(m, NEW_PASSCODE), "the new passcode is set");
	assert.ok(!yes.out.includes(NEW_PASSCODE), "the passcode is never printed");
});

(posix ? test : test.skip)("remote reset refuses when a service set up with no config folder reads the default one, and this shell uses another", () => {
	// launchd on a Mac, systemd elsewhere: the file this platform's services read, with no folder in its environment.
	const m = machine("default-folder");
	m.run(["token", "passcode"]);
	const serviceFile = process.platform === "darwin" ? join(m.home, "Library", "LaunchAgents", "com.localstudio.browser.serve.plist") : join(m.home, ".config", "systemd", "user", "local-studio-browser-serve.service");
	mkdirSync(dirname(serviceFile), { recursive: true });
	writeFileSync(
		serviceFile,
		process.platform === "darwin"
			? "<plist><dict><key>ProgramArguments</key><array><string>/usr/local/bin/local-studio-browser</string><string>serve</string></array></dict></plist>\n"
			: "[Service]\nExecStart=/usr/local/bin/local-studio-browser serve\n",
	);
	const before = readFileSync(join(m.config, "oauth.json"), "utf8");
	const r = m.run(["remote", "reset", "--new-passcode-file", m.file("p", NEW_PASSCODE, 0o600), "--yes", "--json"]);
	assert.equal(r.code, 2, r.out);
	const report = JSON.parse(r.stdout);
	assert.equal(report.code, "config_folder");
	// The machine's HOME has no XDG_CONFIG_HOME, so the default is ~/.local-studio/browser, not the shell's LOCAL_STUDIO_BROWSER_DIR.
	assert.ok(report.message.includes(join(m.home, ".local-studio", "browser")), report.message);
	assert.equal(readFileSync(join(m.config, "oauth.json"), "utf8"), before, "nothing changed");
	// Run in the default folder, as `next` says, it is not refused for the folder.
	const there = m.run(["remote", "reset", "--new-passcode-file", m.file("p2", NEW_PASSCODE, 0o600), "--yes", "--json"], { extra: { LOCAL_STUDIO_BROWSER_DIR: join(m.home, ".local-studio", "browser") } });
	assert.notEqual(JSON.parse(there.stdout).code, "config_folder", there.out);
});

(posix ? test : test.skip)("on a hub, remote reset removes every enrolled device: its credential is refused, its open link closes, and next says to link each again", async () => {
	const { startHub, fakeDevice, tempRoot, teardown } = await import("./helpers/hub-fixture.mjs");
	const hubRoot = tempRoot("local-studio-reset-hub-");
	const hub = await startHub(hubRoot, "hub");
	try {
		// Enrolled through the hub's own /link/enroll: a device with an open link, and a manager device whose credential works.
		const laptop = await fakeDevice(hub, "laptop");
		const code = hub.json(["hub", "code", "--name", "admin pc", "--manage", "--json"]).code;
		const admin = await (await fetch(`${hub.url}/link/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, version: "9.9.9" }) })).json();
		const managerCall = () => fetch(`${hub.url}/link/code`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin.deviceId}.${admin.secret}` }, body: JSON.stringify({ kind: "device" }) });
		assert.notEqual((await managerCall()).status, 401, "the manager credential works before the reset");

		// hub.json as `hub setup` writes it (the fixture serves with --public-url only): the address each device links to.
		writeFileSync(join(hub.config, "hub.json"), JSON.stringify({ publicUrl: hub.url, port: hub.port }), { mode: 0o600 });
		const file = join(hubRoot, "new-passcode");
		writeFileSync(file, NEW_PASSCODE, { mode: 0o600 });
		const r = spawnSync(process.execPath, [cli, "remote", "reset", "--new-passcode-file", file, "--yes", "--json"], { env: hub.env, encoding: "utf8", timeout: 20_000 });
		assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
		const report = JSON.parse(r.stdout);
		assert.deepEqual(report.ended.devices.map((d) => [d.name, d.manage]).sort(), [["admin pc", true], ["laptop", false]]);
		assert.deepEqual(report.left, []);
		assert.deepEqual(readJson(join(hub.config, "hub-devices.json")).devices, [], "read back: no device is enrolled");
		// In the order they enrolled; a name with a space is quoted for the shell.
		assert.deepEqual(report.next.relink, [
			{ device: "laptop", command: "local-studio-browser hub code --name laptop" },
			{ device: "admin pc", command: "local-studio-browser hub code --name 'admin pc' --manage" },
		]);
		assert.match(report.next.message, new RegExp(`local-studio-browser link ${hub.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --code <code>`));

		// The hub refuses the credential at once, and closes the open link within a few seconds.
		assert.equal((await managerCall()).status, 401, "the manager credential is refused");
		const deadline = Date.now() + 8000;
		while (laptop.closedCode() === undefined && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
		assert.equal(laptop.closedCode(), 4001, "the device's open link was closed as removed");
	} finally {
		await teardown([() => hub.stop()], hubRoot);
	}
});
