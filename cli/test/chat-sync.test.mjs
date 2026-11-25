// The panel's chats as Local Studio threads (cli/src/chat-sync.ts): what the panel writes is listed and opened by the app,
// what the app adds comes back once, and neither side's messages are ever lost. Runs against a stand-in for Eukhe's
// store, and against the real daemon with LOCAL_STUDIO_BROWSER_TEST_EUKHE=<program> (helpers/eukhe-store.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";
import { startWorld } from "./helpers/eukhe-store.mjs";

const { ChatSync, mergeTurns, messageKeys } = await loadTs(`
export { ChatSync } from "@src/chat-sync.ts";
export { mergeTurns, messageKeys } from "@src/../../src/threads/merge.ts";`);

const skip = process.platform === "win32" && "Local Studio chats are not on Windows yet";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15_000) => {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return;
	assert.fail(`never: ${what}`);
};

const T0 = 1795600000000;
const user = (text, at) => ({ role: "user", content: [{ type: "text", text }], timestamp: T0 + at });
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const says = (text, at) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "synthetic", model: "m", usage, stopReason: "stop", timestamp: T0 + at });
const texts = (messages) => messages.map((m) => `${m.role[0]}:${m.content.filter((c) => c.type === "text").map((c) => c.text).join("")}`);

/** One panel chat as the extension holds it: it merges what comes back, as src/threads/sync.ts does. */
function panelChat(id, messages, title = "Panel title") {
	const chat = { id, title, createdAt: new Date(T0).toISOString(), lastModified: "v1", messages };
	let v = 1;
	return {
		chat,
		add(...more) {
			chat.messages = [...chat.messages, ...more];
			chat.lastModified = `v${++v}`;
		},
		take(answer) {
			chat.messages = mergeTurns(chat.messages, answer.messages ?? []);
			if (answer.title) chat.title = answer.title;
			chat.lastModified = `v${++v}`;
		},
		get op() {
			return { op: "put", chat: { ...chat, known: messageKeys(chat.messages).filter(Boolean) } };
		},
	};
}

async function scene(t, { start = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "chats-"));
	const saved = { ...process.env };
	process.env.HOME = join(root, "home");
	process.env.EUKHE_CODING_AGENT_DIR = join(root, "home", ".eukhe");
	process.env.LOCAL_STUDIO_BROWSER_HOME = join(root, "data");
	process.env.LOCAL_STUDIO_DATA_DIR = join(root, "app");
	process.env.EUKHE_DAEMON_SOCKET = join(root, "d", "daemon.sock");
	let world = start ? await startWorld(root) : undefined;
	const frames = [];
	let seq = 0;
	const waiting = new Map();
	const make = () =>
		new ChatSync(
			(frame) => {
				if (frame.id === undefined) frames.push(frame);
				else waiting.get(frame.id)?.(frame);
			},
			() => "browser-a",
			{ pollMs: 100, stillMs: 300, platform: "linux" },
		);
	let sync = make();
	t.after(async () => {
		sync.stop();
		await world?.close();
		for (const k of ["HOME", "EUKHE_CODING_AGENT_DIR", "LOCAL_STUDIO_BROWSER_HOME", "LOCAL_STUDIO_DATA_DIR", "EUKHE_DAEMON_SOCKET"]) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		frames,
		get world() {
			return world;
		},
		async start() {
			world = await startWorld(root);
		},
		restart() {
			sync.stop();
			sync = make();
		},
		sessions: join(root, "home", ".eukhe", "sessions"),
		data: join(root, "data"),
		async ask(op) {
			const id = ++seq;
			const frame = await new Promise((resolve) => {
				waiting.set(id, resolve);
				sync.handle({ type: "chats", id, op });
			});
			if (frame.error) throw new Error(frame.error.message);
			return frame.result;
		},
	};
}

test("a chat is listed and opened by the app, whole and in order, even when the daemon starts later", { skip }, async (t) => {
	const s = await scene(t, { start: false });
	assert.equal((await s.ask(panelChat("c1", [user("Hi", 0), says("Hello", 1)]).op)).state, "no-app", "Local Studio never ran here: nothing is made");
	assert.ok(!existsSync(join(s.root, "home", ".eukhe")));
	mkdirSync(join(s.root, "home", ".eukhe"), { recursive: true, mode: 0o700 });
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	assert.equal((await s.ask(c.op)).state, "written");
	const file = join(s.sessions, "browser-c1.jsonl");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const before = readFileSync(file, "utf8");
	assert.equal((await s.ask(c.op)).state, "same");
	assert.equal(readFileSync(file, "utf8"), before);
	await s.start();
	const { sessions } = await s.world.app.call({ type: "list_saved_sessions", cwd: s.root, scope: null });
	const row = sessions.find((r) => r.id === "browser-c1");
	assert.equal(row.name, "Panel title");
	assert.deepEqual(texts(await s.world.messages("browser-c1")), ["u:Hi", "a:Hello"]);
	assert.equal((await s.ask(c.op)).state, "same", "opened in the app and unchanged");
});

test("what the app adds comes back once, and a turn on each side is kept in time order on both", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	await s.world.turn("browser-c1", "MARKone please");
	await until(() => s.frames.length > 0, "the change reached the panel");
	assert.equal(s.frames.length, 1);
	const [frame] = s.frames;
	assert.equal(frame.chat, "c1");
	assert.deepEqual(texts(frame.messages).map((x) => x.slice(0, 18)), ["u:MARKone please", "a:Answer to MARKon"]);
	assert.ok(!JSON.stringify(frame).includes("thinking"));
	// The panel hadn't stored it yet: a put says so again and writes nothing.
	c.add(user("Panel turn", 2), says("Panel answer", 3));
	const changed = await s.ask(c.op);
	assert.equal(changed.state, "changed");
	c.take(changed);
	assert.equal((await s.ask(c.op)).state, "written");
	const app = texts(await s.world.messages("browser-c1"));
	assert.deepEqual(app.map((x) => x.slice(0, 14)), ["u:Hi", "a:Hello", "u:Panel turn", "a:Panel answer", "u:MARKone plea", "a:Answer to MA"]);
	assert.deepEqual(texts(c.chat.messages), app);
	assert.equal((await s.ask(c.op)).state, "same");
	await sleep(1200);
	assert.equal(s.frames.length, 1, "nothing is sent twice");
	// And once more, after the host restarted.
	s.restart();
	await s.ask({ op: "index", chats: [{ id: "c1", lastModified: c.chat.lastModified }] });
	await s.world.turn("browser-c1", "MARKtwo");
	await until(() => s.frames.length === 2, "the second change reached the panel");
	assert.deepEqual(texts(s.frames[1].messages).map((x) => x.slice(0, 18)), ["u:MARKtwo", "a:Answer to MARKtw"]);
});

test("a notice only the app keeps stays where it was when the session is written anew", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	const activeSessionId = await s.world.open("browser-c1");
	await s.world.app.call({ type: "append_custom_message", activeSessionId, message: { customType: "notice", content: "kept by the app", display: true } });
	c.add(user("More", 2), says("Yes", 3));
	assert.equal((await s.ask(c.op)).state, "written");
	const now = await s.world.messages("browser-c1");
	assert.equal(JSON.stringify(now).split("kept by the app").length, 2);
	assert.deepEqual(now.map((m) => m.role), ["user", "assistant", "custom", "user", "assistant"]);
});

test("a running turn in the app is left alone until it ends", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	await s.world.turn("browser-c1", "MARKslow slow", false);
	c.add(user("More", 2), says("Yes", 3));
	await sleep(300);
	assert.equal((await s.ask(c.op)).state, "busy");
	await until(() => s.frames.length > 0, "the turn came back after it ended");
	c.take(s.frames[0]);
	assert.equal((await s.ask(c.op)).state, "written");
	assert.equal((await s.world.messages("browser-c1")).length, 6);
});

test("a name given on either side shows on the other", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	const live = await s.world.open("browser-c1");
	await s.world.app.call({ type: "set_session_name", activeSessionId: live, name: "App name" });
	await until(() => s.frames.length > 0, "the name reached the panel");
	assert.equal(s.frames[0].title, "App name");
	c.take(s.frames[0]);
	assert.equal((await s.ask(c.op)).state, "same");
	c.chat.title = "Panel name";
	c.chat.lastModified = "x";
	assert.equal((await s.ask(c.op)).state, "same");
	const { sessions } = await s.world.app.call({ type: "list_saved_sessions", cwd: s.root, scope: null });
	assert.equal(sessions.find((r) => r.id === "browser-c1").name, "Panel name");
});

test("deleting in the panel takes the thread unless the app added to it; deleting in the app sticks until a new message", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const a = panelChat("a", [user("Hi", 0), says("Hello", 1)]);
	const b = panelChat("b", [user("Hi", 0), says("Hello", 1)]);
	const d = panelChat("d", [user("Hi", 0), says("Hello", 1)]);
	for (const c of [a, b, d]) await s.ask(c.op);
	await s.world.open("browser-b");
	assert.equal((await s.ask({ op: "forget", id: "a" })).state, "deleted", "never opened");
	assert.equal((await s.ask({ op: "forget", id: "b" })).state, "deleted", "opened, nothing added");
	await s.world.turn("browser-d", "MARKkeep");
	await until(() => s.frames.length > 0, "the change reached the panel");
	assert.equal((await s.ask({ op: "forget", id: "d" })).state, "kept");
	assert.deepEqual(readdirSync(s.sessions).filter((f) => f.startsWith("browser-") && !f.endsWith(".jsonl")), ["browser-d"]);
	// Undo in the panel puts it back.
	assert.equal((await s.ask(a.op)).state, "written");
	await s.world.open("browser-a");
	await s.world.end("browser-a");
	await s.world.app.call({ type: "delete_saved_session", sessionPath: join(s.sessions, "browser-a") });
	rmSync(join(s.sessions, "browser-a.jsonl"), { force: true });
	a.chat.lastModified = "later";
	assert.equal((await s.ask(a.op)).state, "gone");
	assert.ok(!existsSync(join(s.sessions, "browser-a.jsonl")));
	a.add(user("Again", 5), says("Ok", 6));
	assert.equal((await s.ask(a.op)).state, "written");
});

test("the app's own threads are listed and read; local-only ones and the panel's are not", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	await s.ask(panelChat("c1", [user("Hi", 0), says("Hello", 1)]).op);
	for (const [id, word] of [["thread-1", "apples"], ["thread-2", "secrets"]])
		writeFileSync(
			join(s.sessions, `${id}.jsonl`),
			`${[{ type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd: s.root }, { type: "session_info", id: "n", parentId: null, timestamp: new Date(T0).toISOString(), name: `About ${word}` }, { type: "message", id: "m0", parentId: "n", timestamp: new Date(T0).toISOString(), message: user(`Tell me of ${word}`, 0) }, { type: "message", id: "m1", parentId: "m0", timestamp: new Date(T0).toISOString(), message: says(`About ${word}`, 1) }].map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	mkdirSync(join(s.root, "app"), { recursive: true });
	writeFileSync(join(s.root, "app", "state.json"), JSON.stringify({ threads: { "thread-2": { localOnly: "2026" } } }));
	const all = await s.ask({ op: "threads" });
	assert.deepEqual(all.threads.map((r) => [r.id, r.title]), [["thread-1", "About apples"]]);
	assert.equal((await s.ask({ op: "threads", query: "APPLES tell" })).threads.length, 1);
	assert.equal((await s.ask({ op: "threads", query: "pears" })).threads.length, 0);
	const one = await s.ask({ op: "thread", id: "thread-1" });
	assert.deepEqual(texts(one.messages), ["u:Tell me of apples", "a:About apples"]);
	await assert.rejects(s.ask({ op: "thread", id: "thread-2" }), /No such/);
	writeFileSync(join(s.root, "app", "state.json"), "not json");
	assert.equal((await s.ask({ op: "threads" })).threads.length, 0, "a state that can't be read keeps every thread local");
});

test("a chat marked local-only in the app stops coming back", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	mkdirSync(join(s.root, "app"), { recursive: true });
	writeFileSync(join(s.root, "app", "state.json"), JSON.stringify({ threads: { "browser-c1": { localOnly: "2026" } } }));
	await s.world.turn("browser-c1", "MARKprivate");
	c.add(user("x", 2), says("y", 3));
	assert.equal((await s.ask(c.op)).state, "local-only");
	await sleep(1000);
	assert.equal(s.frames.length, 0);
});

test("bad ids, damaged state, links in the way and big chats", { skip, timeout: 60_000 }, async (t) => {
	const s = await scene(t);
	for (const id of ["../x", "a/b", "", ".", "a".repeat(65), 5]) await assert.rejects(s.ask({ ...panelChat("x", [user("Hi", 0)]).op, chat: { ...panelChat("x", [user("Hi", 0)]).op.chat, id } }), /bad chat id/);
	await assert.rejects(s.ask({ op: "put", chat: { ...panelChat("x", []).op.chat, messages: [{ role: "custom", content: [], timestamp: 1 }] } }), /bad messages/);
	await assert.rejects(s.ask({ op: "rm" }), /unknown/);
	const target = join(s.root, "target");
	writeFileSync(target, "mine");
	mkdirSync(s.sessions, { recursive: true });
	symlinkSync(target, join(s.sessions, "browser-link.jsonl"));
	symlinkSync(s.root, join(s.sessions, "browser-dir"));
	await assert.rejects(s.ask(panelChat("link", [user("Hi", 0)]).op), /left it alone/);
	await assert.rejects(s.ask(panelChat("dir", [user("Hi", 0)]).op), /left it alone/);
	assert.equal(readFileSync(target, "utf8"), "mine");
	rmSync(join(s.sessions, "browser-link.jsonl"));
	rmSync(join(s.sessions, "browser-dir"));
	const c = panelChat("c1", [user("Hi", 0), says("Hello", 1)]);
	await s.ask(c.op);
	writeFileSync(join(s.data, "chat-sync", "browser-a.json"), "{");
	s.restart();
	const index = await s.ask({ op: "index", chats: [{ id: "c1", lastModified: "v1" }] });
	assert.deepEqual(index.want, ["c1"]);
	assert.equal((await s.ask(c.op)).state, "written");
	assert.ok(existsSync(join(s.sessions, "browser-c1.jsonl")));
	const many = [];
	for (let i = 0; i < 3000; i++) many.push(i % 2 ? says(`a${i}`, i) : user(`u${i}`, i));
	const big = panelChat("big", many);
	assert.equal((await s.ask(big.op)).state, "written");
	assert.equal((await s.world.messages("browser-big")).length, 3000);
	assert.equal((await s.ask(big.op)).state, "same");
	// A chat the panel no longer has goes; an empty list forgets nothing.
	await s.ask({ op: "index", chats: [] });
	assert.ok(existsSync(join(s.sessions, "browser-c1.jsonl")));
	await s.ask({ op: "index", chats: [{ id: "big", lastModified: "v1" }] });
	assert.ok(!existsSync(join(s.sessions, "browser-c1.jsonl")));
});

test("the merge keeps every message once, answers with their questions", () => {
	const here = [user("one", 0), says("a1", 1), user("two", 10)];
	const app = [user("one", 0), says("a1", 1), user("two", 10), says("a2 in the app", 11), user("between", 5), says("b", 6)];
	const merged = mergeTurns(here, app);
	assert.deepEqual(texts(merged), ["u:one", "a:a1", "u:between", "a:b", "u:two", "a:a2 in the app"]);
	assert.deepEqual(mergeTurns(merged, app), merged);
	assert.deepEqual(messageKeys([user("a", 0), user("b", 0)]), [`user:${T0}`, `user:${T0}#2`]);
});
