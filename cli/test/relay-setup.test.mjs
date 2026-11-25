// The steps of `remote setup` on the relay route (cli/src/relay-setup.ts). wrangler is always a stand-in: nothing here reaches Cloudflare.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = mkdtempSync(join(tmpdir(), "local-studio-browser-relay-setup-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mod = await loadTs(`
export { RELAY_JS, RELAY_WRANGLER } from "@src/relay-dist.ts";
export { deploy, deployedAddress, needsSubdomain, onboardingUrl, parseWhoami, putKey, runWrangler, whoami } from "@src/relay-setup.ts";
`);

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ADDRESS = "https://local-studio-browser-relay.test-sub.workers.dev";

/** Run `fn` with LOCAL_STUDIO_BROWSER_DIR at a fresh folder. */
async function inConfig(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const before = process.env.LOCAL_STUDIO_BROWSER_DIR;
	process.env.LOCAL_STUDIO_BROWSER_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (before === undefined) delete process.env.LOCAL_STUDIO_BROWSER_DIR;
		else process.env.LOCAL_STUDIO_BROWSER_DIR = before;
	}
}

test("whoami, the deploy output and wrangler's subdomain words are read as wrangler writes them", () => {
	const who = mod.parseWhoami(`npx: installed\n{"loggedIn":true,"accounts":[{"id":"${ACCOUNT}","name":"Mine"},{"id":"not-an-id"}]}`);
	assert.deepEqual(who, { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] });
	assert.deepEqual(mod.parseWhoami(`{"loggedIn":false}`), { loggedIn: false, accounts: [] });
	assert.equal(mod.parseWhoami("You are not authenticated."), undefined);
	const lines = [`{"type":"wrangler-session"}`, "not json", `{"type":"deploy","targets":["https://u:p@x.workers.dev","http://y.workers.dev","${ADDRESS}/"]}`].join("\n");
	assert.equal(mod.deployedAddress(lines), ADDRESS);
	assert.equal(mod.deployedAddress(`{"type":"deploy","targets":["https://relay.example.com"]}`), undefined);
	assert.ok(mod.needsSubdomain("You need to register a workers.dev subdomain before publishing to workers.dev"));
	assert.ok(!mod.needsSubdomain("Authentication error [code: 10000]"));
	assert.equal(mod.onboardingUrl(ACCOUNT), `https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`);
});

/** A wrangler whose account holds the Workers in `there` (name to secrets and the tags of its versions), and what it was asked. */
function cloudflare(there = {}, deploys = () => ({ code: 0, out: "Deployed", stdout: "" })) {
	const calls = [];
	const wrangler = async (args, options) => {
		calls.push({ args, options });
		const worker = there[args.at(-1)];
		const print = (list) => ({ code: 0, out: JSON.stringify(list), stdout: JSON.stringify(list) });
		if (args[1] === "list") {
			if (!worker) return { code: 1, out: "This Worker does not exist on your account. [code: 10007]", stdout: "" };
			return print(args[0] === "secret" ? worker.secrets.map((name) => ({ name })) : worker.tags.map((tag) => ({ annotations: tag ? { "workers/tag": tag } : { "workers/triggered_by": "secret" } })));
		}
		const held = (there[args.at(-1)] ??= { secrets: [], tags: [] });
		if (args[0] === "deploy") {
			const result = deploys();
			if (result.code === 0) writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, `{"type":"deploy","targets":["${ADDRESS}"]}\n`);
			held.tags.push(args[2]);
			return result;
		}
		held.secrets = ["RELAY_KEY"];
		held.tags.push(undefined);
		return { code: 0, out: "", stdout: "" };
	};
	return { wrangler, calls, deployed: () => calls.filter((c) => c.args[0] === "deploy").length };
}

test("deploy stages the kit 0600 in a folder of its own and reads the address from wrangler's output file", async () => {
	await inConfig("deploy", async (dir) => {
		mkdirSync(join(dir, "relay"), { mode: 0o755 });
		const cf = cloudflare();
		assert.deepEqual(await mod.deploy("local-studio-browser-relay", ACCOUNT, {}, cf), { ok: true, url: ADDRESS });
		assert.deepEqual(cf.calls[1].args.filter((a) => !a.startsWith("local-studio-browser-") || a === "local-studio-browser-relay"), ["deploy", "--tag", "--name", "local-studio-browser-relay"]);
		assert.match(cf.calls[1].args[2], /^local-studio-browser-[0-9a-f]{12}$/);
		assert.equal(cf.calls[1].options.accountId, ACCOUNT);
		assert.equal(cf.calls[1].options.cwd, join(dir, "relay"));
		if (process.platform !== "win32") {
			assert.equal(statSync(join(dir, "relay")).mode & 0o777, 0o700);
			assert.equal(statSync(join(dir, "relay", "relay.js")).mode & 0o777, 0o600);
		}
		assert.equal(readFileSync(join(dir, "relay", "relay.js"), "utf8"), mod.RELAY_JS);
		assert.equal(readFileSync(join(dir, "relay", "wrangler.jsonc"), "utf8"), mod.RELAY_WRANGLER);
		// No subdomain, and a plain failure, each its own answer.
		const subdomain = await mod.deploy("local-studio-browser-relay", ACCOUNT, {}, cloudflare({}, () => ({ code: 1, out: "You need to register a workers.dev subdomain", stdout: "" })));
		assert.deepEqual(subdomain, { ok: false, why: "subdomain" });
		const failed = await mod.deploy("local-studio-browser-relay", ACCOUNT, {}, cloudflare({}, () => ({ code: 1, out: "Authentication error", stdout: "" })));
		assert.equal(failed.why, "failed");
		assert.match(failed.message, /exit 1.*Authentication error/);
	});
});

test("a Worker already on the account is never replaced, save this computer's own or a relay taken over on purpose", async () => {
	const there = { api: { secrets: [], tags: ["v1.2"] }, keyed: { secrets: ["DB_URL"], tags: [undefined] }, untagged: { secrets: ["RELAY_KEY"], tags: [undefined] } };
	const cf = cloudflare(there);
	const deploy = (computer, name, options = {}) => inConfig(computer, () => mod.deploy(name, ACCOUNT, options, cf));
	for (const name of ["api", "keyed"]) {
		assert.deepEqual(await deploy("a", name), { ok: false, why: "other" });
		assert.deepEqual(await deploy("a", name, { takeOver: true }), { ok: false, why: "other" }, "no relay, so nothing to take over");
	}
	assert.deepEqual(await deploy("a", "untagged"), { ok: false, why: "relay" });
	assert.equal(cf.deployed(), 0);
	assert.equal((await deploy("a", "local-studio-browser-relay")).ok, true);
	await inConfig("a", () => mod.putKey("local-studio-browser-relay", "k", ACCOUNT, cf));
	assert.equal((await deploy("a", "local-studio-browser-relay")).ok, true, "its own, with a key");
	assert.deepEqual(await deploy("b", "local-studio-browser-relay"), { ok: false, why: "relay" });
	assert.equal((await deploy("b", "local-studio-browser-relay", { takeOver: true })).ok, true);
	assert.deepEqual(await deploy("a", "local-studio-browser-relay"), { ok: false, why: "relay" }, "taken over since, so it isn't a's any more");
	assert.equal(cf.deployed(), 3);
	// Deleted, and the name used for something else.
	there["local-studio-browser-relay"] = { secrets: [], tags: [undefined] };
	assert.deepEqual(await deploy("b", "local-studio-browser-relay"), { ok: false, why: "other" });
	// An account that can't be read is not an empty one, whatever wrangler exits with.
	for (const answer of [{ code: 1, out: "Authentication error [code: 10000]", stdout: "" }, { code: 0, out: "", stdout: "" }]) {
		const unread = await inConfig("a", () => mod.deploy("new", ACCOUNT, {}, { wrangler: async () => answer }));
		assert.match(unread.message, /versions list failed/);
	}
});

test("a first setup that stopped after the upload left its Worker there with no key, and it is this computer's to finish", async () => {
	for (const out of ["You need to register a workers.dev subdomain", "fetch failed"]) {
		let first = true;
		const cf = cloudflare({}, () => (first ? ((first = false), { code: 1, out, stdout: "" }) : { code: 0, out: "", stdout: "" }));
		await inConfig(`stopped-${out.length}`, async () => {
			assert.equal((await mod.deploy("local-studio-browser-relay", ACCOUNT, {}, cf)).ok, false);
			assert.equal((await mod.deploy("local-studio-browser-relay", ACCOUNT, {}, cf)).ok, true);
		});
	}
});

test("a name that isn't a Worker name never reaches wrangler", async () => {
	await inConfig("names", async () => {
		const cf = cloudflare();
		for (const name of ["x & calc", "-x", "x-", "X", "", "a".repeat(64), "--env=x"]) {
			assert.equal((await mod.deploy(name, ACCOUNT, {}, cf)).ok, false, name);
			assert.equal((await mod.putKey(name, "k", ACCOUNT, cf)).ok, false);
		}
		assert.equal(cf.calls.length, 0);
	});
});

test("the key reaches `secret put` on stdin only, and never comes back in an error", async () => {
	await inConfig("put", async () => {
		const key = "s".repeat(43);
		const cf = cloudflare();
		assert.deepEqual(await mod.putKey("local-studio-browser-relay", key, ACCOUNT, cf), { ok: true });
		const [seen] = cf.calls;
		assert.deepEqual(seen.args, ["secret", "put", "RELAY_KEY", "--name", "local-studio-browser-relay"]);
		assert.equal(seen.options.input, key);
		assert.ok(!seen.args.join(" ").includes(key));
		const bad = await mod.putKey("local-studio-browser-relay", key, ACCOUNT, { wrangler: async () => ({ code: 1, out: `rejected ${key}`, stdout: "" }) });
		assert.equal(bad.ok, false);
		assert.ok(!bad.message.includes(key), bad.message);
		assert.match(bad.message, /rejected <key>/);
	});
});

test("npx gets the pinned wrangler, the key on stdin and no Cloudflare token of the person's", { skip: process.platform === "win32" }, async () => {
	await inConfig("npx", async (dir) => {
		const npx = join(dir, "npx.mjs");
		const set = { LOCAL_STUDIO_BROWSER_NPX: npx, CLOUDFLARE_API_TOKEN: "t", CF_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "e".repeat(32), WRANGLER_CI_OVERRIDE_NAME: "api", WRANGLER_LOG: "error" };
		const before = Object.fromEntries(Object.keys(set).map((key) => [key, process.env[key]]));
		Object.assign(process.env, set);
		const fake = (body) => {
			writeFileSync(npx, `#!${process.execPath}\n${body}`);
			chmodSync(npx, 0o755);
		};
		try {
			fake(`import { readFileSync } from "node:fs";
const env = Object.keys(process.env).filter((k) => /^(CLOUDFLARE|CF|WRANGLER)_/.test(k)).sort().map((k) => k + "=" + process.env[k]);
console.log(JSON.stringify({ args: process.argv.slice(2), env, stdin: readFileSync(0, "utf8") }));`);
			const r = await mod.runWrangler(["secret", "put"], { cwd: dir, accountId: ACCOUNT, input: "the key", timeoutMs: 30_000 });
			assert.deepEqual(JSON.parse(r.stdout), {
				args: ["--yes", "wrangler@4.163.0", "secret", "put"],
				env: [`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`, "WRANGLER_SEND_METRICS=false"],
				stdin: "the key",
			});
			// npm's notice goes to stderr after the answer, and says nothing about it.
			fake(`console.log(JSON.stringify({ loggedIn: true, accounts: [{ id: "${ACCOUNT}", name: "Mine" }] })); setTimeout(() => console.error("npm notice {new} version; not wrangler login"), 20);`);
			assert.deepEqual(await mod.whoami(), { loggedIn: true, accounts: [{ id: ACCOUNT, name: "Mine" }] });
			// One that hangs takes its children with it, and the wait ends.
			fake(`import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
console.log(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }).pid);`);
			const hung = await mod.runWrangler(["deploy"], { cwd: dir, timeoutMs: 1_500 });
			assert.equal(hung.code, 124);
			assert.match(hung.out, /Timed out after 2 s/);
			const grandchild = Number(hung.stdout);
			assert.ok(grandchild > 0);
			const gone = () => {
				try {
					process.kill(grandchild, 0);
					return false;
				} catch {
					return true;
				}
			};
			for (const end = Date.now() + 5_000; !gone() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
			assert.ok(gone(), "wrangler is still running");
			// Nothing to run, with input waiting.
			process.env.LOCAL_STUDIO_BROWSER_NPX = join(dir, "missing");
			assert.equal((await mod.runWrangler(["secret", "put"], { cwd: dir, input: "k", timeoutMs: 5_000 })).code, 127);
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
