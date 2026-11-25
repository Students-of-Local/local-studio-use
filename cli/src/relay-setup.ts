/**
 * The steps of `remote setup` on the relay route (relay.ts), as relay/deploy.md in baney75/local-studio-tunnels lays them out: the
 * person's own wrangler (one pinned version, through npx, never installed globally) signs them in to their own Cloudflare account in
 * their own browser, deploys the vendored relay bundle (relay-dist.ts) to it, and sets RELAY_KEY as a Worker secret through stdin.
 * Local Studio never reads wrangler's stored credentials and never sees a Cloudflare token. remote-setup.ts runs these in order.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import { envVar } from "./env.ts";
import { configDir } from "./files.ts";
import { which } from "./harness.ts";
import { RELAY_JS, RELAY_WRANGLER } from "./relay-dist.ts";
import { validAccountId, validWorkerName } from "./remote-config.ts";
import { systemRoot, writeAtomic } from "./service.ts";

/** The wrangler deploy.md was checked with. Every command runs this one. */
export const WRANGLER_VERSION = "4.163.0";

/** The Worker's name when the person picks none: the first label of https://local-studio-browser-relay.<subdomain>.workers.dev. */
export const DEFAULT_RELAY_NAME = "local-studio-browser-relay";

export const relayFolder = () => join(configDir(), "relay");

/** Where a fresh account picks its workers.dev subdomain, the one thing wrangler can't do without a terminal prompt. */
export const onboardingUrl = (accountId: string) => `https://dash.cloudflare.com/${accountId}/workers/onboarding`;

export interface WranglerOptions {
	cwd: string;
	accountId?: string;
	/** More environment for wrangler, such as WRANGLER_OUTPUT_FILE_PATH. */
	env?: Record<string, string>;
	/** Written to stdin, then stdin closes: how the key reaches `secret put` without argv or a file. */
	input?: string;
	/** The person's terminal: wrangler's own output and its browser sign-in. */
	inherit?: boolean;
	timeoutMs: number;
}

/** `out` is both streams, for messages; `stdout` is what a command answers, without npm's notices. */
export interface WranglerResult {
	code: number;
	out: string;
	stdout: string;
}

export interface RelaySeam {
	/** Runs `npx --yes wrangler@<version> <args>`; tests pass a stand-in. */
	wrangler?: (args: string[], options: WranglerOptions) => Promise<WranglerResult>;
}

/** npx from the person's Node.js, or LOCAL_STUDIO_BROWSER_NPX for tests. */
export function npxBinary(): string | undefined {
	return envVar("NPX") || which("npx");
}

/** Wrangler is npx's child, and cmd.exe's on Windows, so ending the first process alone would leave it deploying. */
function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync(win32.join(systemRoot(), "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export function runWrangler(args: string[], options: WranglerOptions): Promise<WranglerResult> {
	const npx = npxBinary();
	if (!npx) return Promise.resolve({ code: 127, out: "npx isn't on PATH.", stdout: "" });
	// A Cloudflare token, account or Worker name set for other work would win over the person's browser sign-in and our arguments, and
	// a log level would change what wrangler prints.
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_(CI_|LOG))/i.test(key)));
	const env = { ...inherited, WRANGLER_SEND_METRICS: "false", NO_UPDATE_NOTIFIER: "1", ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {}), ...options.env };
	return new Promise((resolve) => {
		// npx is a .cmd on Windows, which Node runs only through a shell, so its path is quoted (C:\Program Files). Every argument is
		// fixed here or a validWorkerName.
		const windows = process.platform === "win32";
		const child = spawn(windows ? `"${npx}"` : npx, ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args], {
			cwd: options.cwd,
			env,
			stdio: options.inherit ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			shell: windows,
			windowsHide: true,
			// A group of its own to end on a timeout; the sign-in stays in the terminal's, so Ctrl-C reaches it.
			detached: !windows && !options.inherit,
		});
		let out = "";
		let stdout = "";
		const done = (code: number, message = "") => {
			clearTimeout(timer);
			resolve({ code, out: out + message, stdout });
		};
		child.stdout?.on("data", (b: Buffer) => {
			stdout += b;
			out += b;
		});
		child.stderr?.on("data", (b: Buffer) => (out += b));
		const timer = setTimeout(() => {
			killTree(child);
			child.stdout?.destroy();
			child.stderr?.destroy();
			done(124, `\nTimed out after ${Math.round(options.timeoutMs / 1000)} s.`);
		}, options.timeoutMs);
		child.on("error", (err) => done(127, err.message));
		child.on("close", (code) => done(code ?? 1));
		// A wrangler that never read its input: the exit code already says it failed.
		child.stdin?.on("error", () => {});
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

const wrangler = (seam: RelaySeam) => seam.wrangler ?? runWrangler;

export interface CloudflareAccount {
	id: string;
	name: string;
}

/** `wrangler whoami --json`: signed in and which accounts, or undefined when the output isn't that. */
export function parseWhoami(out: string): { loggedIn: boolean; accounts: CloudflareAccount[] } | undefined {
	const start = out.indexOf("{");
	if (start < 0) return undefined;
	let raw: { loggedIn?: unknown; accounts?: unknown };
	try {
		raw = JSON.parse(out.slice(start)) as typeof raw;
	} catch {
		return undefined;
	}
	if (typeof raw?.loggedIn !== "boolean") return undefined;
	const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
		.filter((a): a is { id: string; name?: unknown } => Boolean(a) && typeof a.id === "string" && validAccountId(a.id))
		.map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : a.id }));
	return { loggedIn: raw.loggedIn, accounts };
}

export async function whoami(seam: RelaySeam = {}): Promise<{ loggedIn: boolean; accounts: CloudflareAccount[] } | { error: string }> {
	mkdirSync(relayFolder(), { recursive: true, mode: 0o700 });
	const r = await wrangler(seam)(["whoami", "--json"], { cwd: relayFolder(), timeoutMs: 180_000 });
	const parsed = parseWhoami(r.stdout);
	if (parsed) return parsed;
	// A signed-out wrangler exits non-zero; it says so in words when --json has nothing to print.
	if (/not authenticated|not logged in|wrangler login/i.test(r.out)) return { loggedIn: false, accounts: [] };
	return { error: `wrangler whoami failed (exit ${r.code})${r.out ? `: ${r.out.trim().slice(-300)}` : ""}` };
}

/** `wrangler login` in the person's terminal: wrangler opens Cloudflare's sign-in page in their browser and waits for it. */
export async function login(seam: RelaySeam = {}): Promise<boolean> {
	mkdirSync(relayFolder(), { recursive: true, mode: 0o700 });
	return (await wrangler(seam)(["login"], { cwd: relayFolder(), inherit: true, timeoutMs: 10 * 60_000 })).code === 0;
}

/** The deploy kit in a folder of its own, as deploy.md asks. */
export function stageRelay(dir: string = relayFolder()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700); // mkdir's mode is only for a folder it makes.
	writeAtomic(join(dir, "relay.js"), RELAY_JS, 0o600);
	writeAtomic(join(dir, "wrangler.jsonc"), RELAY_WRANGLER, 0o600);
}

/** Wrangler's words when the account has no workers.dev subdomain and there is no terminal to ask in. */
export const needsSubdomain = (out: string): boolean => /register a workers\.dev subdomain|\/workers\/onboarding/i.test(out);

/** The deployed workers.dev address from WRANGLER_OUTPUT_FILE_PATH's lines: the `deploy` entry's target on workers.dev. */
export function deployedAddress(ndjson: string): string | undefined {
	for (const line of ndjson.split("\n")) {
		let entry: { type?: unknown; targets?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry?.type !== "deploy" || !Array.isArray(entry.targets)) continue;
		for (const target of entry.targets) {
			if (typeof target !== "string") continue;
			try {
				const url = new URL(target);
				if (url.protocol === "https:" && url.hostname.endsWith(".workers.dev") && !url.username && !url.password) return url.origin;
			} catch {
				// Not a URL; the next one may be.
			}
		}
	}
	return undefined;
}

/** Marks the versions this computer deploys, 25 characters at most. It outlives `remote off`, so setting up again takes the same Worker. */
function computerTag(): string {
	const file = join(relayFolder(), "computer");
	try {
		const tag = readFileSync(file, "utf8");
		if (/^local-studio-browser-[0-9a-f]{12}$/.test(tag)) return tag;
	} catch {
		// Nothing deployed from here yet.
	}
	const tag = `local-studio-browser-${randomBytes(6).toString("hex")}`;
	writeAtomic(file, tag, 0o600);
	return tag;
}

/** What a `--json` command printed, when it is a list. */
function listed(r: WranglerResult): unknown[] | undefined {
	try {
		const list: unknown = JSON.parse(r.stdout);
		return r.code === 0 && Array.isArray(list) ? list : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What a deploy to this name would replace, as Cloudflare has it: whoever deployed last is in the newest version's tag, which a
 * secret's own version doesn't carry. `relay` is another computer's, so a new key would cut that one off; `other` is no relay at all.
 * Wrangler itself would replace either unasked.
 */
async function replaces(name: string, accountId: string | undefined, seam: RelaySeam): Promise<{ kind: "nothing" | "mine" | "relay" | "other" } | { kind: "unknown"; message: string }> {
	const ask = (args: string[]) => wrangler(seam)([...args, "--name", name], { cwd: relayFolder(), accountId, timeoutMs: 180_000 });
	const unknown = (what: string, r: WranglerResult) => ({ kind: "unknown" as const, message: `wrangler ${what} list failed (exit ${r.code})${r.out ? `: ${r.out.trim().slice(-300)}` : ""}` });
	const asked = await ask(["versions", "list", "--json"]);
	if (asked.code !== 0 && /\bcode: 10007\b/.test(asked.out)) return { kind: "nothing" };
	const versions = listed(asked) as { annotations?: Record<string, unknown> }[] | undefined;
	if (!versions) return unknown("versions", asked);
	// Oldest first.
	const tags = versions.map((v) => v?.annotations?.["workers/tag"]).filter((t) => typeof t === "string" && t.startsWith("local-studio-browser-"));
	if (tags.length) return { kind: tags.at(-1) === computerTag() ? "mine" : "relay" };
	const asked2 = await ask(["secret", "list"]);
	const secrets = listed(asked2) as { name?: unknown }[] | undefined;
	if (!secrets) return unknown("secret", asked2);
	return { kind: secrets.some((s) => s?.name === "RELAY_KEY") ? "relay" : "other" };
}

export type DeployResult = { ok: true; url: string } | { ok: false; why: "subdomain" } | { ok: false; why: "relay" } | { ok: false; why: "other" } | { ok: false; why: "failed"; message: string };

/**
 * `wrangler deploy --tag <computer> --name <name>` with the staged kit. With no terminal, wrangler asks nothing; a missing subdomain is its own answer.
 * A Worker already there is never replaced, save one this computer deployed or, with `takeOver`, another computer's relay.
 */
export async function deploy(name: string, accountId: string | undefined, { takeOver = false }: { takeOver?: boolean } = {}, seam: RelaySeam = {}): Promise<DeployResult> {
	if (!validWorkerName(name)) return { ok: false, why: "failed", message: `${name} isn't a Worker name: lowercase letters, digits and dashes, 63 at most.` };
	const dir = relayFolder();
	stageRelay(dir);
	const there = await replaces(name, accountId, seam);
	if (there.kind === "unknown") return { ok: false, why: "failed", message: there.message };
	if (there.kind === "other" || (there.kind === "relay" && !takeOver)) return { ok: false, why: there.kind };
	const output = join(dir, "deploy-output.ndjson");
	rmSync(output, { force: true });
	const r = await wrangler(seam)(["deploy", "--tag", computerTag(), "--name", name], { cwd: dir, accountId, env: { WRANGLER_OUTPUT_FILE_PATH: output }, timeoutMs: 5 * 60_000 });
	let lines = "";
	try {
		lines = readFileSync(output, "utf8");
	} catch {
		// No output file: the deploy never got that far.
	}
	const url = r.code === 0 ? deployedAddress(lines) : undefined;
	if (url) return { ok: true, url };
	if (needsSubdomain(r.out)) return { ok: false, why: "subdomain" };
	return { ok: false, why: "failed", message: r.code === 0 ? "wrangler deploy finished but named no workers.dev address." : `wrangler deploy failed (exit ${r.code})${r.out ? `: ${r.out.trim().slice(-400)}` : ""}` };
}

/** `wrangler secret put RELAY_KEY` with the key on stdin, so it never touches argv, a file or a log. */
export async function putKey(name: string, key: string, accountId: string | undefined, seam: RelaySeam = {}): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!validWorkerName(name)) return { ok: false, message: `${name} isn't a Worker name.` };
	mkdirSync(relayFolder(), { recursive: true, mode: 0o700 });
	const r = await wrangler(seam)(["secret", "put", "RELAY_KEY", "--name", name], { cwd: relayFolder(), accountId, input: key, timeoutMs: 3 * 60_000 });
	if (r.code === 0) return { ok: true };
	return { ok: false, message: `wrangler secret put RELAY_KEY failed (exit ${r.code})${r.out ? `: ${r.out.replaceAll(key, "<key>").trim().slice(-300)}` : ""}` };
}
