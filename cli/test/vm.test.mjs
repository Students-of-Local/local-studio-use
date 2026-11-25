// `local-studio-browser vm` (docs/decisions.md, D66): argument parsing, the resource gate and its readers, the sparse
// image writer and the cloud-init seed. Booting a guest needs Virtualization.framework; scripts/vm-bench.mjs
// does that on a Mac.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { existingHelper, gateProblems, lockGuest, MIN_FREE_DISK, parsePmset, parseVmArgs, parseVmStat, RAM_HEADROOM, request, startFlags, userData, writeSparse } from "../src/vm.ts";
import { watchFocus } from "../../scripts/vm-bench-focus.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const GiB = 1024 ** 3;

test("vm arguments parse strictly", () => {
	assert.deepEqual(parseVmArgs(["list"]), { sub: "list", cold: false, fromReady: false, force: false, json: false });
	assert.deepEqual(parseVmArgs(["list", "--json"]), { sub: "list", cold: false, fromReady: false, force: false, json: true });
	assert.deepEqual(parseVmArgs(["up", "linux", "--cold", "--force"]), { sub: "up", name: "linux", cold: true, fromReady: false, force: true, json: false });
	assert.deepEqual(parseVmArgs(["up", "linux", "--from-ready"]), { sub: "up", name: "linux", cold: false, fromReady: true, force: false, json: false });
	assert.deepEqual(parseVmArgs(["reset", "linux", "--json"]), { sub: "reset", name: "linux", cold: false, fromReady: false, force: false, json: true });
	assert.equal(parseVmArgs(["shot", "linux", "--out", "a.png"]).out, "a.png");
	assert.equal(parseVmArgs(["shot", "linux", "--out=b.png"]).out, "b.png");
	assert.equal(parseVmArgs(["exec", "linux", "--", "ls", "-la", "/root"]).cmd, "ls -la /root");
	assert.equal(parseVmArgs(["exec", "linux", "uname -a"]).cmd, "uname -a");
	// Flags after the name belong to the guest command, not to vm.
	assert.equal(parseVmArgs(["exec", "linux", "--json"]).cmd, "--json");
	// So does a -- of the guest command's own.
	assert.equal(parseVmArgs(["exec", "linux", "git", "checkout", "--", "file"]).cmd, "git checkout -- file");
	assert.equal(parseVmArgs(["exec", "linux", "--", "rm", "--", "-f"]).cmd, "rm -- -f");
});

test("vm refuses what it would otherwise misread", () => {
	const problems = [
		[[], /needs a command/],
		[["start", "linux"], /Unknown vm command "start"/],
		[["up"], /needs a guest name/],
		[["up", "Linux"], /not a guest name/],
		[["up", "../x"], /not a guest name/],
		[["up", "a".repeat(33)], /not a guest name/],
		[["reset", "linux", "--cold"], /takes no option "--cold"/],
		[["up", "linux", "--cold", "--from-ready"], /exclude each other/],
		[["reset", "linux", "--from-ready"], /takes no option "--from-ready"/],
		[["down", "linux", "--force"], /takes no option "--force"/],
		[["up", "linux", "--json=1"], /takes no value/],
		[["shot", "linux", "--out"], /--out needs a file name/],
		[["shot", "linux", "--out", "--json"], /--out needs a file name/],
		[["reset", "linux", "extra"], /Unexpected argument "extra"/],
		[["list", "linux"], /takes no name/],
		[["exec", "linux"], /needs a command after the name/],
		[["exec", "linux", "--"], /needs a command after the name/],
	];
	for (const [args, pattern] of problems) {
		const got = parseVmArgs(args);
		assert.equal(typeof got, "string", `${args.join(" ")} should be refused`);
		assert.match(got, pattern, args.join(" "));
	}
});

const roomy = { onAC: true, availableRam: 8 * GiB, freeDisk: 100 * GiB, load1: 2, cpus: 10 };

test("the gate passes a host with room", () => {
	assert.deepEqual(gateProblems(roomy, GiB, false), []);
	assert.deepEqual(gateProblems({ ...roomy, onAC: undefined }, GiB, false), [], "a Mac without a battery is fine");
});

test("the gate refuses low disk and low RAM even with --force", () => {
	const disk = gateProblems({ ...roomy, freeDisk: MIN_FREE_DISK - 1 }, GiB, true);
	assert.equal(disk.length, 1);
	assert.match(disk[0], /free on disk; a guest needs at least 5\.0 GB/);
	assert.deepEqual(gateProblems({ ...roomy, freeDisk: MIN_FREE_DISK }, GiB, false), [], "exactly 5 GB is enough");
	const ram = gateProblems({ ...roomy, availableRam: GiB + RAM_HEADROOM - 1 }, GiB, true);
	assert.equal(ram.length, 1);
	assert.match(ram[0], /of RAM available/);
});

test("the gate refuses battery and load unless --force", () => {
	const battery = { ...roomy, onAC: false };
	assert.match(gateProblems(battery, GiB, false)[0], /on battery/);
	assert.deepEqual(gateProblems(battery, GiB, true), []);
	const busy = { ...roomy, load1: 10.5 };
	assert.match(gateProblems(busy, GiB, false)[0], /load is 10\.5 on 10 cores/);
	assert.deepEqual(gateProblems(busy, GiB, true), []);
	assert.deepEqual(gateProblems({ ...roomy, load1: 10 }, GiB, false), [], "load equal to the core count passes");
});

test("the gate reads pmset and vm_stat", () => {
	assert.equal(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;"), true);
	assert.equal(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging;"), false);
	assert.equal(parsePmset("Now drawing from 'UPS Power'"), undefined);
	const vmStat = [
		"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
		"Pages free:                               10000.",
		"Pages active:                            500000.",
		"Pages inactive:                           20000.",
		"Pages speculative:                         3000.",
		"Pages throttled:                              0.",
	].join("\n");
	assert.equal(parseVmStat(vmStat), (10000 + 20000 + 3000) * 16384);
	assert.equal(parseVmStat("garbage"), 0, "unreadable output counts as no RAM, so the gate refuses");
});

test("the image is written sparse and byte for byte", async () => {
	const dir = mkdtempSync(join(tmpdir(), "local-studio-vm-test-"));
	try {
		// APFS keeps gaps under about 32 MB allocated, so the image here is 64 MiB with three short runs of data.
		const block = 64 * 1024;
		const data = Buffer.alloc(1024 * block);
		data.write("start", 0);
		data.write("middle", block * 500 + 7);
		data.write("end", data.length - 3);
		// Odd chunk sizes cross block boundaries.
		const chunks = [];
		for (let at = 0; at < data.length; at += 1000003) chunks.push(data.subarray(at, at + 1000003));
		const out = join(dir, "disk.raw");
		const size = await writeSparse(Readable.from(chunks), out);
		assert.equal(size, data.length);
		assert.equal(statSync(out).size, data.length);
		assert.ok(readFileSync(out).equals(data));
		assert.ok(statSync(out).blocks * 512 <= 1024 * 1024, `the 3 blocks with data take space, not 64 MiB, got ${statSync(out).blocks * 512} bytes`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the seed has no users, no SSH and the vsock agent", () => {
	const seed = userData("linux");
	assert.match(seed, /^#cloud-config\n/);
	assert.match(seed, /^users: \[\]$/m);
	assert.match(seed, /^ssh_pwauth: false$/m);
	assert.doesNotMatch(seed, /ssh_authorized_keys|ssh-rsa|ssh-ed25519|passwd|chpasswd/);
	assert.match(seed, /systemctl, disable, --now, ssh\.service, ssh\.socket/);
	assert.match(seed, /AF_VSOCK/);
	assert.match(seed, /s\.bind\(\(socket\.VMADDR_CID_ANY, 1024\)\)/);
	// The agent's Python sits inside a YAML block: every line indented by six spaces.
	const agent = seed.slice(seed.indexOf("#!/usr/bin/python3"), seed.indexOf("  - path: /etc/systemd"));
	for (const line of agent.split("\n").slice(1, -1)) if (line) assert.match(line, /^ {6}/, line);
});

test("up starts from the ready point only when the guest has no disk", () => {
	assert.deepEqual(startFlags({ cold: false }, true), [], "a disk is booted as it stands");
	assert.deepEqual(startFlags({ cold: true }, true), ["--cold"]);
	assert.deepEqual(startFlags({ cold: false }, false), ["--from-ready"]);
});

/** A guest directory whose helper answers status with `states` in order, the last one from then on. */
async function fakeHelper(t, states) {
	const dir = mkdtempSync(join(tmpdir(), "tvm-"));
	const server = createServer((socket) =>
		socket.once("data", () => {
			const state = states.length > 1 ? states.shift() : states[0];
			socket.end(state === null ? "" : `${JSON.stringify({ ok: true, state, ...(state === "failed" && { error: "no reset point" }) })}\n`);
			if (state === "stopping" && states.length === 1 && states[0] === "gone") server.close();
		}),
	);
	await new Promise((done) => server.listen(join(dir, "control.sock"), done));
	t.after(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

test("up waits for a start or stop already under way instead of calling the guest up", async (t) => {
	const soon = () => Date.now() + 10_000;
	assert.equal((await existingHelper(await fakeHelper(t, ["starting", "starting", "running"]), soon())).state, "running");
	assert.equal((await existingHelper(await fakeHelper(t, ["resetting", "running"]), soon())).state, "running");
	const failed = await existingHelper(await fakeHelper(t, ["starting", "failed"]), soon());
	assert.deepEqual([failed.state, failed.error], ["failed", "no reset point"]);
	assert.equal(await existingHelper(await fakeHelper(t, ["stopping", "gone"]), soon()), undefined, "an old helper that left makes room for a new start");
	assert.equal((await existingHelper(await fakeHelper(t, ["starting"]), Date.now() + 100)).state, "starting", "not up when the wait ends");
	assert.equal((await existingHelper(await fakeHelper(t, [null]), Date.now() + 100)).ok, false, "a helper that closes without an answer is not gone");
	const none = mkdtempSync(join(tmpdir(), "tvm-"));
	t.after(() => rmSync(none, { recursive: true, force: true }));
	assert.equal(await existingHelper(none, soon()), undefined);
});

test("a helper that closes the connection without an answer fails the request at once", async (t) => {
	const dir = await fakeHelper(t, [null]);
	await assert.rejects(request(dir, { op: "exec" }, 600_000), /closed without answering exec/);
});

test("one command at a time creates, starts or resets a guest; the next one waits, and a dead one's lock is taken over", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "tvm-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const said = [];
	const lock = (ms) => lockGuest(root, "g", Date.now() + ms, (line) => said.push(line));
	const unlock = await lock(0);
	await assert.rejects(lock(0), /another `vm` command \(process \d+\) is still working on g/);
	assert.equal(said.length, 0);
	await (await lockGuest(root, "h", Date.now(), () => {}))(); // another guest has its own lock

	// Two wait; each gets it only after the one before lets go.
	const order = [];
	const waiting = ["second", "third"].map(async () => {
		const un = await lock(10_000);
		order.push("in");
		await new Promise((done) => setTimeout(done, 80));
		order.push("out");
		un();
	});
	await new Promise((done) => setTimeout(done, 150));
	assert.deepEqual(order, [], "nothing runs while the first holds it");
	assert.equal(said.length, 2, "each says once that it waits");
	unlock();
	await Promise.all(waiting);
	assert.deepEqual(order, ["in", "out", "in", "out"]);

	// Killed while it held the lock: the lock file stays, and the next command takes it over.
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise((done) => child.on("exit", done));
	writeFileSync(join(root, "g.lock"), `${child.pid} gone`);
	const all = [];
	let held = 0;
	for (let i = 0; i < 5; i++)
		all.push(
			lock(10_000).then(async (un) => {
				assert.equal(++held, 1, "one holder");
				await new Promise((done) => setTimeout(done, 10));
				held--;
				un();
			}),
		);
	await Promise.all(all);
	assert.deepEqual(readdirSync(root), [], "no lock files are left");
	// The commands that change a stopped guest run inside it, before they read its folder.
	const source = readFileSync(join(dirname(cli), "..", "src", "vm.ts"), "utf8");
	assert.match(source, /const unlock = args\.sub === "up" \|\| args\.sub === "reset" \? await lockGuest\([^;]+;\s*try \{\s*return await guestCommand\(/);
	assert.equal(source.match(/ensureGuest\(/g).length, 2, "only the locked `up` makes a guest");
});

const mac = process.platform === "darwin" && process.arch === "arm64";
test("only reset discards a stopped guest's disk", { skip: mac ? false : "vm runs on Apple silicon" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "tvm-"));
	const guest = join(root, "guests", "g");
	mkdirSync(guest, { recursive: true });
	for (const name of ["disk.raw", "ready.raw", "session.vzvmsave"]) writeFileSync(join(guest, name), name);
	const vm = (...args) => spawnSync(process.execPath, [cli, "vm", ...args], { encoding: "utf8", env: { ...process.env, LOCAL_STUDIO_BROWSER_VM_DIR: root } });
	const has = (name) => existsSync(join(guest, name));
	// A helper that listens but never answers (spawnSync blocks this process) is slow, not gone.
	const silent = createServer();
	try {
		const up = vm("up", "g", "--from-ready", "--force");
		assert.equal(up.status, 1);
		assert.match(up.stderr, /--from-ready never overwrites one/);
		assert.equal(readFileSync(join(guest, "disk.raw"), "utf8"), "disk.raw");
		assert.ok(has("session.vzvmsave"));

		await new Promise((done) => silent.listen(join(guest, "control.sock"), done));
		assert.notEqual(vm("reset", "g").status, 0);
		assert.ok(has("disk.raw") && has("session.vzvmsave"), "a guest whose helper is slow keeps its disk");
		await new Promise((done) => silent.close(done));

		const reset = vm("reset", "g");
		assert.equal(reset.status, 0, reset.stderr);
		assert.ok(!has("disk.raw") && !has("session.vzvmsave") && has("ready.raw"));
	} finally {
		silent.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI refuses a bad vm command with exit 2 and lists vm in help", () => {
	const bad = spawnSync(process.execPath, [cli, "vm", "up", "Bad"], { encoding: "utf8" });
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /not a guest name/);
	const none = spawnSync(process.execPath, [cli, "vm"], { encoding: "utf8" });
	assert.equal(none.status, 2);
	const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
	assert.match(help.stdout, /\nGuests\n/);
	assert.match(help.stdout, /vm reset <name>/);
});

test("the bench counts focus changes only from a watcher that stayed up", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "vm-focus-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const helper = (name, script) => {
		const path = join(dir, name);
		writeFileSync(path, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
		return path;
	};
	const stays = (last) => `process.on("SIGTERM", () => { ${last} process.exit(0); }); setInterval(() => {}, 1e6); console.log("watching");`;
	// An older helper has no focus-watch: it prints its usage and exits.
	await assert.rejects(watchFocus(helper("old", "process.exit(2);")), /exited 2 before it was watching/);
	await assert.rejects(watchFocus(join(dir, "missing")), /ENOENT/);
	const quiet = await watchFocus(helper("quiet", stays("")));
	assert.deepEqual(await quiet.stop(), []);
	// What it printed while the bench was blocked in a command still counts.
	const busy = await watchFocus(helper("busy", stays('console.log("activated com.example.app");')));
	assert.deepEqual(await busy.stop(), ["com.example.app"]);
	const gone = await watchFocus(helper("gone", 'console.log("watching");'));
	await new Promise((done) => setTimeout(done, 1500));
	assert.equal(await gone.stop(), undefined);
	// One that crashed, or was killed, has no count even when the bench hears of it only at the stop.
	const killed = await watchFocus(helper("killed", 'console.log("watching"); setInterval(() => {}, 1e6);'));
	assert.equal(await killed.stop(), undefined);
});
