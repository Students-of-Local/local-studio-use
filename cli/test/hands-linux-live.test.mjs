// The Linux helper (hands/linux) on real widgets: every verb against the GTK fixture in a private headless desktop.
// It runs only inside that desktop, with the helper named:
//
//   hands/linux/test/headless-session.sh x11 -- env LOCAL_STUDIO_COMPUTER_LIVE_BIN=$PWD/hands/linux/target/release/local-studio-computer \
//     node --test cli/test/hands-linux-live.test.mjs
//
// CI runs it the same way under Xvfb with openbox and under headless sway (.github/workflows/browser-hands-linux.yml).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertError, HandsSession } from "./helpers/hands-conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.LOCAL_STUDIO_COMPUTER_LIVE_BIN;
const fixture = resolve(here, "..", "..", "hands", "linux", "test", "fixture.py");
const cli = resolve(here, "..", "dist", "index.js");
const skip = !bin ? "set LOCAL_STUDIO_COMPUTER_LIVE_BIN inside hands/linux/test/headless-session.sh" : false;
const x11 = Boolean(process.env.DISPLAY) && !process.env.WAYLAND_DISPLAY;
const xdotool = x11 && spawnSync("xdotool", ["version"]).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gives focus back to the person's window, the way the person would. */
function focusPerson() {
	if (xdotool) spawnSync("xdotool", ["search", "--name", "Person Window", "windowactivate", "--sync"]);
	else if (process.env.SWAYSOCK) spawnSync("swaymsg", ['[title="^Person Window$"] focus']);
}

let root;
let env;
let s;
let win;
let winPid;
// Sway 1.10 added the sandbox criteria. Before it (or with LOCAL_STUDIO_COMPUTER_SWAY_HOLD) open takes the pid route.
const swayHolds = (() => {
	if (!process.env.SWAYSOCK) return false;
	if (process.env.LOCAL_STUDIO_COMPUTER_SWAY_HOLD) return true;
	try {
		const { major, minor } = JSON.parse(spawnSync("swaymsg", ["-r", "-t", "get_version"], { encoding: "utf8" }).stdout);
		return major < 1 || (major === 1 && minor < 10);
	} catch {
		return false;
	}
})();
const statFields = (pid) => {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
	} catch {
		return [];
	}
};
const procState = (pid) => statFields(pid)[0] ?? "";
const holderOf = (pid) => {
	try {
		return readFileSync(`/proc/${statFields(pid)[1]}/cmdline`, "utf8");
	} catch {
		return "";
	}
};

function setAccess(access, apps = [fixture]) {
	writeFileSync(join(env.LOCAL_STUDIO_BROWSER_DIR, "hands.json"), JSON.stringify({ access, apps }));
}

/** The rows text of a snapshot, failing on an error envelope. */
async function rows(args) {
	const { result, envelope } = await s.call("snapshot", args);
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(envelope, undefined, "rows, not an envelope");
	return result.content[0].text;
}

/** The ref of the first row whose line matches `re`, from a fresh snapshot. */
async function refOf(re) {
	const text = await rows({ window: win });
	const id = text.match(/^snapshot (\S+)/)[1];
	const line = text.split("\n").find((l) => re.test(l));
	assert.ok(line, `no row matches ${re} in:\n${text}`);
	return `@${id}:e${line.match(/\[(\d+)\]/)[1]}`;
}

async function ok(name, args) {
	const { result, envelope } = await s.call(name, args);
	assert.ok(envelope?.ok, `${name} ${JSON.stringify(args)}: ${result.content[0].text}`);
	return { data: envelope.data, result };
}

/** What the fixture's Status label says: every handler writes there, so this is the app's own read-back. */
async function status() {
	const ref = await refOf(/statictext "Status"/);
	const { data } = await ok("get", { ref, property: "text" });
	return data.value;
}

async function statusBecomes(want) {
	let last;
	for (let i = 0; i < 20; i++) {
		last = await status();
		if (last === want) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal(last, want);
}

before(async () => {
	if (skip) return;
	root = mkdtempSync(join(tmpdir(), "hands-live-"));
	env = {
		...process.env,
		LOCAL_STUDIO_BROWSER_DIR: join(root, "config"),
		LOCAL_STUDIO_BROWSER_CACHE_DIR: join(root, "cache"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_DATA_HOME: join(root, "data"),
	};
	mkdirSync(env.LOCAL_STUDIO_BROWSER_DIR, { recursive: true });
	setAccess("default");
	s = new HandsSession(bin, ["mcp"], env);
	await s.initialize();
});

after(async () => {
	if (skip) return;
	await s?.close();
	rmSync(root, { recursive: true, force: true });
});

test("open starts the fixture as an agent window and gives focus back", { skip }, async () => {
	const { data } = await ok("open", { app: fixture });
	win = data.window;
	assert.equal(typeof win, "number");
	assert.equal(data.title, "Hands Fixture");
	assert.ok(["agent_started", "agent_workspace"].includes(data.scope), data.scope);
	if (data.focus.changed) assert.equal(data.focus.returned, true, "focus goes back to the person's window");
	if (process.env.SWAYSOCK) {
		// Sway places the app before it maps: straight onto the agent workspace, never focused.
		assert.equal(data.scope, "agent_workspace");
		assert.equal(data.workspace, "local-studio-agent");
		assert.equal(data.focus.changed, false);
		// The rules that placed it name this launch's security context (Sway 1.10 and later), never a process id another
		// app could reuse. Before 1.10 they name the pid, and a `local-studio-computer hold` parent keeps it from reuse.
		const tree = JSON.parse(spawnSync("swaymsg", ["-r", "-t", "get_tree"], { encoding: "utf8" }).stdout);
		const views = [];
		const walk = (n) => {
			if (n.id === win) views.push(n);
			for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
		};
		walk(tree);
		assert.equal(views.length, 1);
		winPid = data.pid;
		if (swayHolds) assert.match(holderOf(winPid), /local-studio-computer\0hold\0/, "the app's parent holds its pid");
		else assert.match(views[0].sandbox_instance_id ?? "", /^local-studio-browser-[0-9a-f]{32}$/, JSON.stringify(views[0]).slice(0, 400));
	}
	const list = (await ok("windows", {})).data;
	assert.equal(list.access, "default");
	assert.ok(list.windows.some((w) => w.id === win && w.accessible));
	assert.ok(!list.windows.some((w) => w.title === "Person Window"), "Default lists no window of the person's");
});

test("snapshot prints real rows; find and get read them", { skip }, async () => {
	const text = await rows({ window: win });
	for (const re of [/textfield "Note"/, /button "Save"/, /checkbox "Remember me" \(unchecked\)/, /combobox "Color" ="Red"/, /spinbutton "Volume" =10/, /menubar/]) {
		assert.match(text, re);
	}
	const { data } = await ok("find", { window: win, role: "button", name: "save" });
	assert.equal(data.count, 1);
	assert.match(data.matches[0].ref, /^@s\w+:e\d+$/);
	const title = await ok("get", { ref: data.matches[0].ref, property: "role" });
	assert.equal(title.data.value, "button");
});

test("accents, a dash and an emoji are typed whole into an entry", { skip }, async () => {
	const ref = await refOf(/textfield "Note"/);
	const text = "café – naïve 😀";
	await ok("set_value", { ref, value: "" });
	assert.equal((await ok("type", { ref: await refOf(/textfield "Note"/), text, wait: 0 })).data.evidence.value, text);
	await ok("set_value", { ref: await refOf(/textfield "Note"/), value: "" });
});

test("an app started without Full Access can't read the person's files", { skip }, async () => {
	const { pid } = (await ok("windows", {})).data.windows.find((w) => w.id === win);
	assert.match(readFileSync(`/proc/${pid}/status`, "utf8"), /^NoNewPrivs:\t1$/m);
	assert.equal(realpathSync(`/proc/${pid}/cwd`), realpathSync(join(root, "data", "local-studio-browser", "app-home")));
	assert.match(readFileSync(`/proc/${pid}/environ`, "utf8"), new RegExp(`(^|\0)HOME=${root}/data/local-studio-browser/app-home\0`));
});

test("type and get: text lands in the field and reads back", { skip }, async () => {
	const ref = await refOf(/textfield "Note"/);
	const { data } = await ok("type", { ref, text: "hello from hands", wait: 0 });
	assert.equal(data.evidence.kind, "value_readback");
	assert.equal(data.evidence.value, "hello from hands");
	assert.equal(data.verified, true);
	assert.equal((await ok("get", { ref })).data.value, "hello from hands");
});

test("click by ref and by window text runs the button", { skip }, async () => {
	await ok("click", { ref: await refOf(/button "Save"/), wait: 0 });
	await statusBecomes("saved: hello from hands");
	await ok("set_value", { ref: await refOf(/textfield "Note"/), value: "second", wait: 0 });
	const { data } = await ok("click", { window: win, text: "Save", wait: 0 });
	assert.equal(data.matched.role, "button");
	await statusBecomes("saved: second");
});

test("set_value, toggle and select change controls and read them back", { skip }, async () => {
	const field = await ok("set_value", { ref: await refOf(/textfield "Note"/), value: "replaced", wait: 0 });
	assert.equal(field.data.evidence.value, "replaced");
	const spin = await ok("set_value", { ref: await refOf(/spinbutton "Volume"/), value: "42", wait: 0 });
	assert.equal(spin.data.verified, true);
	await statusBecomes("volume: 42");
	const box = await ok("toggle", { ref: await refOf(/checkbox "Remember me"/), wait: 0 });
	assert.equal(box.data.state, "on");
	await statusBecomes("remember: on");
	const pick = await ok("select", { ref: await refOf(/combobox "Color"/), option: "Blue", wait: 0 });
	assert.equal(pick.data.verified, true);
	assert.equal(pick.data.evidence.how, "selection", JSON.stringify(pick.data));
	await statusBecomes("color: Blue");
	assert.match(await rows({ window: win, query: "Color" }), /combobox "Color" ="Blue"/);
});

test("press edits text and activates through accessibility", { skip }, async () => {
	const ref = await refOf(/textfield "Note"/);
	await ok("press", { ref, key: "ctrl+a BackSpace", wait: 0 });
	assert.equal((await ok("get", { ref })).data.value, "");
	await ok("press", { ref, key: "o k", wait: 0 });
	assert.equal((await ok("get", { ref })).data.value, "ok");
	await ok("press", { ref, key: "Return", wait: 0 });
	await statusBecomes("entered: ok");
	assertError(await s.call("press", { ref, key: "F5", wait: 0 }), "not_supported", "never");
});

test("menu runs a menu bar item and refuses a disabled one", { skip }, async () => {
	const { data } = await ok("menu", { window: win, path: "Edit > Clear Note", wait: 0 });
	assert.equal(data.menus_closed, true, JSON.stringify(data));
	await statusBecomes("note cleared");
	assertError(await s.call("menu", { window: win, path: "File > Disabled Item", wait: 0 }), "not_supported");
});

test("a click that opens a dialog reports it, and the dialog is usable", { skip }, async () => {
	const { data } = await ok("click", { ref: await refOf(/button "Open Dialog"/), wait: 0 });
	assert.ok(Array.isArray(data.opened) && data.opened.length === 1, JSON.stringify(data));
	const dialog = data.opened[0].window;
	assert.equal(typeof dialog, "number", "the dialog has a window id");
	const text = await rows({ window: dialog });
	assert.match(text, /Fixture dialog/);
	await ok("click", { window: dialog, text: "OK", wait: 0 });
	await statusBecomes("dialog closed");
});

test("snapshot since latest lists only what changed", { skip }, async () => {
	await rows({ window: win });
	await ok("set_value", { ref: await refOf(/textfield "Note"/), value: "changed", wait: 0 });
	const diff = await rows({ window: win, since: "latest" });
	assert.match(diff, /changes since your last read/);
	assert.match(diff, /textfield "Note" ="changed"/);
	assert.ok(diff.split("\n").length < 12, diff);
});

test("run_steps acts in order and reads the window once at the end", { skip }, async () => {
	await rows({ window: win });
	const note = await refOf(/textfield "Note"/);
	const save = await refOf(/button "Save"/);
	const { data, result } = await ok("run_steps", {
		steps: [
			{ tool: "computer_set_value", args: { ref: note, value: "batched" } },
			{ tool: "click", args: { ref: save } },
		],
		wait: 0,
	});
	assert.equal(data.complete, true, JSON.stringify(data));
	assert.equal(data.read.text_below, true);
	assert.equal(result.content.length, 2);
	await statusBecomes("saved: batched");
});

test("click_at acts on the element under a window point", { skip }, async () => {
	const ref = await refOf(/button "Save"/);
	const b = (await ok("get", { ref, property: "bounds" })).data.value;
	await ok("set_value", { ref: await refOf(/textfield "Note"/), value: "pointed", wait: 0 });
	const { data } = await ok("click_at", { window: win, x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2), wait: 0 });
	assert.equal(data.element.role, "button");
	await statusBecomes("saved: pointed");
});

test("scroll moves a scrolled list; drag and right clicks are refused, never faked", { skip }, async () => {
	const { data } = await ok("scroll", { ref: await refOf(/cell "Item 1"$/), direction: "down", amount: 3, wait: 0 });
	assert.equal(data.verified, true);
	assertError(await s.call("drag", { window: win, x: 1, y: 1, x2: 50, y2: 50, wait: 0 }), "not_supported", "never");
	assertError(await s.call("click", { ref: await refOf(/button "Save"/), button: "right", wait: 0 }), "not_supported", "never");
});

test("refs: a browser ref, an unknown snapshot and a gone element answer in protocol codes", { skip }, async () => {
	assertError(await s.call("get", { ref: "e12" }), "bad_arguments", "never");
	assertError(await s.call("get", { ref: "@szzzzzzzz:e1" }), "unknown_ref", "after_snapshot");
	await rows({ window: win });
	await rows({ window: win, since: "latest" });
	assertError(await s.call("get", { ref: "1" }), "stale_bare_row", "after_snapshot");
});

test("shot pictures the window as a labeled PNG, and under Default only when nothing covers it", { skip: skip || (xdotool ? false : "needs X11 and xdotool to move the person's window") }, async () => {
	const person = spawnSync("xdotool", ["search", "--name", "Person Window"]).stdout.toString().trim().split("\n")[0];
	const geo = Object.fromEntries(
		spawnSync("xdotool", ["getwindowgeometry", "--shell", String(win)])
			.stdout.toString()
			.trim()
			.split("\n")
			.map((l) => l.split("=")),
	);
	try {
		// The person's window over the fixture: a picture would show it, so Default refuses.
		spawnSync("xdotool", ["windowmove", "--sync", person, geo.X, geo.Y]);
		spawnSync("xdotool", ["windowactivate", "--sync", person]);
		const covered = await s.call("shot", { window: win });
		assertError(covered, "not_supported", "safe");
		assert.match(covered.envelope.error.message, /covers part of window/);
		// Out of the way, the fixture is pictured (openbox animates the minimize, so its frame unmaps a moment later).
		spawnSync("xdotool", ["windowminimize", "--sync", person]);
		let shot = await s.call("shot", { window: win });
		for (let i = 0; i < 30 && !shot.envelope?.ok; i++) {
			await sleep(100);
			shot = await s.call("shot", { window: win });
		}
		assert.ok(shot.envelope?.ok, shot.result.content[0].text);
		const { data } = shot.envelope;
		const { result } = shot;
		assert.equal(result.content.length, 3);
		assert.match(result.content[1].text, /untrusted/);
		assert.equal(result.content[2].type, "image");
		assert.equal(result.content[2].mimeType, "image/png");
		assert.ok(existsSync(data.path));
		assert.deepEqual([...readFileSync(data.path).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
		assert.ok(data.width > 100 && data.height > 100, JSON.stringify(data));
	} finally {
		focusPerson();
	}
});

test("on wlroots, shot under Default refuses: grim would show whatever covers the window", { skip: skip || (process.env.SWAYSOCK ? false : "sway only") }, async () => {
	const answer = await s.call("shot", { window: win });
	assertError(answer, "not_supported");
	assert.match(answer.envelope.error.message, /under default access/);
});

test("the person's window is off limits under Default and open under Full", { skip }, async () => {
	assertError(await s.call("snapshot", { app: "hands-person" }), "outside_agent_workspace", "never");
	setAccess("full");
	try {
		const list = (await ok("windows", {})).data;
		assert.equal(list.access, "full");
		const person = list.windows.find((w) => w.title === "Person Window");
		assert.ok(person, JSON.stringify(list));
		assert.equal(person.scope, "person");
		assert.match(await rows({ window: person.id }), /textfield/);
	} finally {
		setAccess("default");
	}
});

test("Read Only refuses actions and still reads", { skip }, async () => {
	setAccess("read_only");
	try {
		const ref = await refOf(/textfield "Note"/);
		assertError(await s.call("type", { ref, text: "no", wait: 0 }), "permission_denied", "never");
		assertError(await s.call("open", { app: fixture }), "permission_denied", "never");
		assert.notEqual((await ok("get", { ref })).data.value, "no");
	} finally {
		setAccess("default");
	}
});

test("an action waits while the person uses the app, then answers in_use", { skip: skip || (x11 && spawnSync("xdotool", ["version"]).status === 0 ? false : "needs X11 and xdotool to give the fixture focus") }, async () => {
	const ref = await refOf(/button "Save"/);
	spawnSync("xdotool", ["windowactivate", "--sync", String(win)]);
	try {
		const started = Date.now();
		assertError(await s.call("click", { ref, wait: 1 }), "in_use", "safe");
		assert.ok(Date.now() - started >= 900, "it waited");
		assert.equal((await ok("get", { ref, property: "role" })).data.value, "button", "reads never wait");
	} finally {
		const person = (await ok("windows", {})).data;
		void person;
		spawnSync("xdotool", ["search", "--name", "Person Window", "windowactivate", "--sync"]);
	}
});

test("after every verb, the person's typing still reaches their own window", { skip: skip || (x11 && spawnSync("xdotool", ["version"]).status === 0 ? false : "needs X11 and xdotool to type as the person") }, async () => {
	const typed = spawnSync("xdotool", ["search", "--name", "Person Window", "windowactivate", "--sync", "type", "--delay", "20", "mine"]);
	assert.equal(typed.status, 0, String(typed.stderr));
	setAccess("full");
	try {
		const person = (await ok("windows", {})).data.windows.find((w) => w.title === "Person Window");
		const text = await rows({ window: person.id });
		assert.match(text, /textfield.*="?mine"?/, "no grab of the helper's making swallowed the person's keys");
	} finally {
		setAccess("default");
	}
});

test("open refuses apps that hold the person's data and apps not allowed", { skip }, async () => {
	assertError(await s.call("open", { app: "firefox" }), "needs_sandbox", "never");
	assertError(await s.call("open", { app: "/bin/true" }), "needs_lend", "never");
});

test("the person's own launch of an app an agent started opens in a process of theirs", { skip }, async () => {
	// The fixture is single-instance per session bus. Were the agent's copy on the person's bus, this launch would
	// open its window in the agent's process (an agent's window, on sway moved to the agent workspace).
	const child = spawn("python3", [fixture], { env: process.env, stdio: "ignore", detached: true });
	setAccess("full");
	try {
		let list = [];
		let theirs;
		for (let i = 0; i < 40 && !theirs; i++) {
			list = (await ok("windows", {})).data.windows;
			theirs = list.find((w) => w.title === "Hands Fixture" && w.id !== win);
			if (!theirs) await sleep(250);
		}
		assert.ok(theirs, `the person's launch showed a window: ${JSON.stringify(list)}`);
		const agents = list.find((w) => w.id === win);
		assert.notEqual(theirs.pid, agents.pid, "a process of the person's, not the agent's copy");
		assert.equal(theirs.scope, "person");
		assert.notEqual(theirs.workspace, "local-studio-agent");
	} finally {
		try {
			process.kill(child.pid);
		} catch {}
		for (let i = 0; i < 20; i++) {
			const left = (await s.call("windows", {})).envelope?.data?.windows ?? [];
			if (!left.some((w) => w.title === "Hands Fixture" && w.id !== win)) break;
			await sleep(250);
		}
		setAccess("default");
		focusPerson();
	}
});

test("on sway, an app whose window comes from a process it forked is placed (1.10 and later) or refused and closed (before)", { skip: skip || (process.env.SWAYSOCK ? false : "sway only") }, async () => {
	// A launcher that forks instead of exec: the window's pid is not the pid the helper started.
	const forked = join(root, "forked-app");
	writeFileSync(forked, `#!/bin/sh\npython3 '${fixture}' &\nwait\n`, { mode: 0o755 });
	// Under Full Access: without it an app has no file but its own program, and this launcher runs another's.
	setAccess("full", [fixture, forked]);
	try {
		const had = new Set((await ok("windows", {})).data.windows.map((w) => w.id));
		const call = await s.call("open", { app: forked });
		if (swayHolds) {
			// The pid rules miss the forked process's window: the helper closes it, stops the app and says so.
			assertError(call, "not_supported", "never");
			let left = [];
			for (let i = 0; i < 20; i++) {
				left = ((await s.call("windows", {})).envelope?.data?.windows ?? []).filter((w) => !had.has(w.id));
				if (!left.length) break;
				await sleep(250);
			}
			assert.deepEqual(left, [], "the stray window is gone");
		} else {
			// Every client of the launch's own socket carries its security context, the forked one too.
			assert.ok(call.envelope?.ok, call.result.content[0].text);
			assert.equal(call.envelope.data.workspace, "local-studio-agent");
			await ok("close", { window: call.envelope.data.window });
		}
	} finally {
		setAccess("default");
	}
});

test("the person's window still has focus after every verb above", { skip }, async () => {
	setAccess("full");
	try {
		const list = (await ok("windows", {})).data;
		const person = list.windows.find((w) => w.title === "Person Window");
		assert.equal(person?.in_use, true, JSON.stringify(list.windows.map((w) => ({ title: w.title, in_use: w.in_use }))));
	} finally {
		setAccess("default");
	}
});

test("close shuts the window this session opened", { skip }, async () => {
	const { data } = await ok("close", { window: win });
	assert.equal(data.verified, true, JSON.stringify(data));
	assertError(await s.call("snapshot", { window: win }), "window_not_found");
	if (swayHolds) {
		// The app is gone, but its pid stays taken (a zombie of the holder) for as long as Sway keeps its pid rules.
		let state = "";
		for (let i = 0; i < 40 && state !== "Z"; i++) {
			state = procState(winPid);
			if (state !== "Z") await sleep(250);
		}
		assert.equal(state, "Z", "the agent app's pid is held after it exits");
		assert.match(holderOf(winPid), /local-studio-computer\0hold\0/);
	}
});

test("through local-studio-browser mcp: computer_open the fixture, type into its text field, read it back", { skip: skip || (existsSync(cli) ? false : "build the CLI first (cd cli && npm run build)") }, async () => {
	setAccess("default");
	const client = new Client({ name: "hands-linux-live", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { ...env, LOCAL_STUDIO_COMPUTER_BIN: bin, LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(root, "sock"), LOCAL_STUDIO_BROWSER_NO_UPDATE_CHECK: "1" },
			stderr: "ignore",
		}),
	);
	try {
		const envelope = (answer) => JSON.parse(answer.content[0].text);
		let names = [];
		for (let i = 0; i < 20 && !names.includes("computer_type"); i++) {
			names = (await client.listTools()).tools.map((t) => t.name);
			if (!names.includes("computer_type")) await new Promise((r) => setTimeout(r, 250));
		}
		assert.ok(names.includes("computer_type"), `computer_* tools listed: ${names.filter((n) => n.startsWith("computer_")).join(", ")}`);
		const opened = envelope(await client.callTool({ name: "computer_open", arguments: { app: fixture } }));
		assert.ok(opened.ok, JSON.stringify(opened));
		const window = opened.data.window;
		const snap = (await client.callTool({ name: "computer_snapshot", arguments: { window } })).content[0].text;
		const id = snap.match(/^snapshot (\S+)/)[1];
		const line = snap.split("\n").find((l) => /textfield "Note"/.test(l));
		assert.ok(line, snap);
		const ref = `@${id}:e${line.match(/\[(\d+)\]/)[1]}`;
		const typed = envelope(await client.callTool({ name: "computer_type", arguments: { ref, text: "through local-studio-browser" } }));
		assert.ok(typed.ok, JSON.stringify(typed));
		const read = envelope(await client.callTool({ name: "computer_get", arguments: { ref } }));
		assert.ok(read.ok, JSON.stringify(read));
		assert.equal(read.data.value, "through local-studio-browser");
		const closed = envelope(await client.callTool({ name: "computer_close", arguments: { window } }));
		assert.equal(closed.data.verified, true, JSON.stringify(closed));
	} finally {
		await client.close();
	}
});
