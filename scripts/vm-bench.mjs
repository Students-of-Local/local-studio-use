#!/usr/bin/env node
// The #28 bench for `local-studio-browser vm` on this Mac: cold start, warm start, reset, idle CPU and host focus
// changes, measured through the CLI as a person runs it. Prints the table, appends one JSON line per run to
// $XDG_STATE_HOME/local-studio-browser/vm-bench.jsonl (~/.local/state/...), and exits 1 when a target is missed.
//
//   node scripts/vm-bench.mjs [--runs N] [--idle-seconds S] [--guest NAME] [--force]
//
// It makes its own guest (default "bench") and discards that guest's session and disk over and over, so it
// refuses a guest it didn't make. Leave the Mac alone while it runs: every app activation counts as a focus
// change. --force passes the battery and load checks of the resource gate, as `vm up --force` does.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { watchFocus } from "./vm-bench-focus.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli", "dist", "index.js");
const { values: opts } = parseArgs({
	options: {
		runs: { type: "string", default: "5" },
		"idle-seconds": { type: "string", default: "30" },
		guest: { type: "string", default: "bench" },
		force: { type: "boolean", default: false },
	},
});
const runs = Number(opts.runs);
const idleSeconds = Number(opts["idle-seconds"]);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a whole number, 1 or more");
if (!(idleSeconds > 0)) throw new Error("--idle-seconds takes a number above 0");
const guest = opts.guest;
const force = opts.force ? ["--force"] : [];
if (!existsSync(cli)) throw new Error("Build the CLI first: (cd cli && npm run build)");

const vmRoot =
	process.env.LOCAL_STUDIO_BROWSER_VM_DIR ||
	join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "local-studio-browser", "vm");
const dir = join(vmRoot, "guests", guest);
const mark = join(dir, "made-by-vm-bench");
if (existsSync(dir) && !existsSync(mark))
	throw new Error(
		`${dir} wasn't made by this bench, and the bench wipes its guest. Name another with --guest, or delete that folder.`,
	);

/** Run `local-studio-browser vm ...`; return its wall time in ms and its parsed --json output. */
function vm(...args) {
	const t0 = performance.now();
	const res = spawnSync(process.execPath, [cli, "vm", ...args], { encoding: "utf8" });
	const ms = performance.now() - t0;
	if (res.status !== 0)
		throw new Error(`local-studio-browser vm ${args.join(" ")} exited ${res.status}: ${res.stderr.trim()}`);
	let json;
	try {
		json = JSON.parse(res.stdout);
	} catch {
		json = undefined;
	}
	return { ms, json, stdout: res.stdout };
}

const running = () => vm("list", "--json").json.find((g) => g.name === guest)?.state === "running";

/** CPU seconds a process has used, from ps (minutes:seconds.hundredths). */
function cpuSeconds(pid) {
	const out = execFileSync("ps", ["-o", "time=", "-p", String(pid)], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	}).trim();
	const parts = out.split(":").map(Number);
	return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;
const spread = (xs) => `${sec(median(xs))} (${sec(Math.min(...xs))} to ${sec(Math.max(...xs))}, ${xs.length} runs)`;

const helper = process.env.LOCAL_STUDIO_BROWSER_VM_HELPER || join(vmRoot, "bin", "local-studio-vm");

const result = {
	at: new Date().toISOString(),
	commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	runs,
	idleSeconds,
	load: loadavg()[0],
	host: execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(),
};

if (running()) vm("down", guest);
// Untimed for a guest that has a ready point: this leaves the helper built and the disk in place, so the first
// cold start below is one. A new guest's first boot is cloud-init, then the ready point.
let provisionMs;
try {
	const hadReady = existsSync(join(dir, "ready.vzvmsave"));
	const first = vm("up", guest, ...force);
	if (!hadReady) provisionMs = first.ms;
} finally {
	if (existsSync(dir)) writeFileSync(mark, "");
}
vm("down", guest);

/** `up` with these flags, which must start the guest the way the row says. */
function up(how, ...flags) {
	const got = vm("up", guest, "--json", ...flags, ...force);
	if (got.json?.boot !== how) throw new Error(`the ${how} start was not one: ${got.json?.boot}`);
	return got.ms;
}

/** What `lsof` lists for these arguments, or undefined when it could not look. */
function lsof(...args) {
	const res = spawnSync("lsof", ["-w", ...args], { encoding: "utf8" });
	return res.error || res.stderr.trim() ? undefined : res.stdout.trim().split("\n").filter(Boolean);
}

const cold = [];
const warmReady = [];
const warmSession = [];
const reset = [];
let resetClean = true;
let helperIdle;
let guestIdle;
let sockets;
let activations;
// Over SSH or from a background job no activation reaches the helper, and a count of 0 would mean nothing.
const inSession = spawnSync("launchctl", ["managername"], { encoding: "utf8" }).stdout?.trim() === "Aqua";
const watcher = inSession ? await watchFocus(helper) : undefined;
try {
	for (let i = 0; i < runs; i++) {
		cold.push(up("cold", "--cold"));
		vm("down", guest);
	}
	for (let i = 0; i < runs; i++) {
		vm("reset", guest); // stopped: drops the session and the disk, so --from-ready may make a new one
		warmReady.push(up("ready", "--from-ready"));
		vm("down", guest);
	}
	for (let i = 0; i < runs; i++) {
		warmSession.push(up("session"));
		vm("down", guest);
	}

	vm("up", guest, ...force);
	for (let i = 0; i < runs; i++) {
		// On the disk, not only in the guest's page cache, and read back from the disk.
		vm("exec", guest, "--", "echo bench > /root/bench-marker && sync");
		reset.push(vm("reset", guest).ms);
		const check = vm(
			"exec",
			guest,
			"--",
			"echo 3 > /proc/sys/vm/drop_caches; if test -e /root/bench-marker; then echo present; else echo gone; fi",
		);
		if (check.stdout.trim() !== "gone") resetClean = false;
	}

	// Idle: the helper, and the Virtualization process that holds this guest's disk (the guest itself).
	const helperPid = vm("up", guest, "--json").json.pid;
	const guestPid = Number(lsof("-t", join(dir, "disk.raw"))?.[0]);
	await new Promise((done) => setTimeout(done, 5000));
	const h0 = cpuSeconds(helperPid);
	const g0 = guestPid ? cpuSeconds(guestPid) : undefined;
	await new Promise((done) => setTimeout(done, idleSeconds * 1000));
	helperIdle = ((cpuSeconds(helperPid) - h0) / idleSeconds) * 100;
	if (guestPid) guestIdle = ((cpuSeconds(guestPid) - g0) / idleSeconds) * 100;
	// Telemetry: the helper opens no network socket (the guest's NAT traffic belongs to the guest). One look, at idle.
	const listed = lsof("-a", "-p", String(helperPid), "-i");
	if (listed) sockets = Math.max(listed.length - 1, 0);
	vm("down", guest);
} finally {
	try {
		if (running()) vm("down", guest);
	} finally {
		activations = await watcher?.stop();
	}
}

Object.assign(result, {
	provisionMs,
	coldMs: cold,
	warmReadyMs: warmReady,
	warmSessionMs: warmSession,
	resetMs: reset,
	resetClean,
	helperIdlePct: helperIdle,
	guestIdlePct: guestIdle,
	helperNetworkSockets: sockets ?? null,
	focusChanges: activations?.length ?? null,
	focusApps: activations ?? null,
});

const rows = [
	["Linux cold start", "8 s or less", spread(cold), "14.5 s", median(cold) <= 8000],
	["Linux warm start, ready point", "1 s or less", spread(warmReady), "1.1 to 1.9 s", median(warmReady) <= 1000],
	["Linux warm start, saved session", "1 s or less", spread(warmSession), "1.1 to 1.9 s", median(warmSession) <= 1000],
	[
		"Linux reset to clean",
		"1 s or less",
		`${spread(reset)}${resetClean ? "" : ", NOT CLEAN"}`,
		"fork in ms (SDK)",
		median(reset) <= 1000 && resetClean,
	],
	[
		"Idle CPU of the helper",
		"5% or less",
		`${helperIdle.toFixed(2)}% over ${idleSeconds} s`,
		"about 50%",
		helperIdle <= 5,
	],
	[
		"Telemetry",
		"off, nothing sent",
		sockets === undefined ? "not measured" : `${sockets} network sockets in the idle helper`,
		"on by default",
		sockets === 0,
	],
	[
		"Focus changes on the host",
		"0",
		activations ? [activations.length, ...activations].join(" ") : "not measured",
		"not measured",
		activations?.length === 0,
	],
];
const info = [
	[
		"Idle CPU of the guest's VM process",
		guestIdle === undefined
			? "not measured"
			: `${guestIdle.toFixed(2)}% over ${idleSeconds} s (the guest kernel and its services)`,
	],
	[
		"First boot of a new guest",
		provisionMs === undefined
			? "not run (the guest had a ready point)"
			: `${sec(provisionMs)} (cloud-init, then saving the ready point; the image download and helper build too, when they were needed)`,
	],
];

result.passed = rows.every((row) => row[4]);
console.log("| Measure | Target | Ours (median, range) | Cua today | Pass |");
console.log("| --- | --- | --- | --- | --- |");
for (const [measure, target, ours, cua, pass] of rows)
	console.log(`| ${measure} | ${target} | ${ours} | ${cua} | ${pass ? "yes" : "NO"} |`);
console.log("");
for (const [measure, value] of info) console.log(`${measure}: ${value}`);
console.log(
	`Times are wall clock through \`local-studio-browser vm\`, including Node's start (about 0.14 s). Host: ${result.host}.`,
);

const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "local-studio-browser");
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, "vm-bench.jsonl"), `${JSON.stringify(result)}\n`);
console.log(`Logged to ${join(stateDir, "vm-bench.jsonl")}`);
process.exitCode = result.passed ? 0 : 1;
