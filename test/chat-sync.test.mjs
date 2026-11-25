// The extension's half of "same chats here and in the Local Studio app" (src/threads/sync.ts): what is sent and when, what
// comes back and where it goes, and how the app's own threads join the panel's list (src/threads/app-threads.ts).
// The host's half is cli/test/chat-sync.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const { atRest, onChats, resyncChats, startChatSync, syncChat } = await import("../src/threads/sync.ts");
const { mergeTurns, messageKeys } = await import("../src/threads/merge.ts");
const { toSession } = await import("../src/threads/session.ts");
const { setThreadSource, SHARE_OLDER_KEY, SHARED_SINCE_KEY } = await import("../src/threads/store.ts");
const { CHAT_MERGE } = await import("../src/threads/events.ts");
const { CHAT_SYNC_KEY } = await import("../src/threads/keys.ts");
const { folderName, inOrder, unopened } = await import("../src/threads/app-threads.ts");

// Built from parts, so this file never holds a literal key.
const KEY = ["sk-ant", "api03", "AbCdEf0123456789AbCdEf0123456789"].join("-");
const user = (timestamp, text) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const answer = (timestamp, text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const call = (timestamp) => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "navigate", arguments: {} }], timestamp });
const result = (timestamp) => ({ role: "toolResult", toolCallId: "t1", toolName: "navigate", content: [], isError: false, timestamp });
const texts = (messages) => messages.map((m) => m.content?.[0]?.text ?? m.role);

/** One browser: chats in memory, a host that answers as `host` says, and panels that answer as `panel` says. */
async function world({ chats = [], host = () => ({ state: "same" }), panel, storage = {} } = {}) {
	installFakeChrome();
	const { chrome } = globalThis;
	await chrome.storage.local.set({ [SHARED_SINCE_KEY]: "2026-11-01T00:00:00.000Z", ...storage });
	// Let the change above go by before the sync listens.
	await new Promise((r) => setTimeout(r, 30));
	const listeners = [];
	chrome.runtime.onMessage = { addListener: (f) => listeners.push(f) };
	chrome.runtime.getURL = (path) => `chrome-extension://id/${path}`;
	const asked = [];
	chrome.runtime.sendMessage = async (message) => {
		if (message.type === CHAT_MERGE) asked.push(message);
		return message.type === CHAT_MERGE ? panel : undefined;
	};
	const rows = new Map(chats.map((c) => [c.id, c]));
	setThreadSource({
		list: async () => [...rows.values()].map(({ messages: _, ...meta }) => meta),
		read: async (id) => {
			const row = rows.get(id);
			if (!row) return {};
			const { messages: _, ...meta } = row;
			return { meta, data: row };
		},
		write: async (meta, data) => void rows.set(data.id, { ...data, ...meta, messages: data.messages }),
	});
	const sent = [];
	startChatSync((frame) => {
		sent.push(frame.op);
		queueMicrotask(() => onChats({ type: "chats", id: frame.id, result: host(frame.op) }));
		return true;
	});
	return { rows, sent, asked, listeners, chrome };
}

const chat = (id, extra = {}) => ({
	id,
	title: "Hotels",
	createdAt: "2026-11-20T10:00:00.000Z",
	lastModified: "2026-11-20T10:05:00.000Z",
	messages: [user(1, "Find hotels"), answer(2, "Three options.")],
	...extra,
});

test("a chat at rest is sent, with keys removed and reasoning left behind", async () => {
	const messages = [
		user(1, `My key is ${KEY}`),
		{ role: "navigation", url: "https://a.example", title: "A" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Done." }], timestamp: 2 },
	];
	const { sent } = await world({ chats: [chat("a", { messages, title: `About ${KEY}` })] });
	await syncChat("a");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].op, "put");
	const text = JSON.stringify(sent[0]);
	assert.doesNotMatch(text, /sk-ant-api03|private|navigation/);
	assert.deepEqual(texts(sent[0].chat.messages), ["My key is [secret]", "Done."]);
	assert.deepEqual(sent[0].chat.known, ["user:1", "assistant:2"]);
});

test("a private chat, one from before sharing began and a deleted one are forgotten, never sent", async () => {
	const { sent } = await world({
		chats: [chat("private", { localStudioPrivate: true }), chat("old", { createdAt: "2026-10-01T00:00:00.000Z" })],
	});
	for (const id of ["private", "old", "gone"]) await syncChat(id);
	assert.deepEqual(sent, [{ op: "forget", id: "private" }, { op: "forget", id: "old" }, { op: "forget", id: "gone" }]);
	const shared = await world({ chats: [chat("old", { createdAt: "2026-10-01T00:00:00.000Z" })], storage: { [SHARE_OLDER_KEY]: true } });
	await syncChat("old");
	assert.deepEqual(shared.sent.map((s) => s.op), ["put"]);
});

test("off in Privacy: nothing is sent, nothing that arrives is put in, and turning it off tells the host", async () => {
	const { sent, rows, chrome } = await world({ chats: [chat("a")], storage: { [CHAT_SYNC_KEY]: false } });
	await syncChat("a");
	await resyncChats();
	onChats({ type: "chats", event: "changed", chat: "a", messages: [user(9, "From the app")] });
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(sent, []);
	assert.equal(rows.get("a").messages.length, 2);
	await chrome.storage.local.set({ [CHAT_SYNC_KEY]: true });
	await chrome.storage.local.set({ [CHAT_SYNC_KEY]: false });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.at(-1).op, "off");
});

test("a chat in the middle of a run waits: an unanswered message or an open tool call is not at rest", () => {
	assert.equal(atRest([user(1, "Go")]), false);
	assert.equal(atRest([user(1, "Go"), call(2)]), false);
	assert.equal(atRest([user(1, "Go"), call(2), result(3)]), false);
	assert.equal(atRest([user(1, "Go"), call(2), result(3), answer(4, "Done")]), true);
	assert.equal(atRest([user(1, "Go"), { ...call(2), stopReason: "aborted" }]), true);
	assert.equal(atRest([answer(1, "Hello")]), false, "a chat nobody has written in");
	assert.equal(atRest([]), false);
});

test("what the app added is put into a chat no panel shows, then both sides are compared again", async () => {
	let round = 0;
	const { rows, sent } = await world({
		chats: [chat("a")],
		host: () => (round++ === 0 ? { state: "changed", messages: [user(3, "Cheaper?"), answer(4, "One.")], title: "Cheap hotels" } : { state: "same" }),
	});
	await syncChat("a");
	assert.deepEqual(texts(rows.get("a").messages), ["Find hotels", "Three options.", "Cheaper?", "One."]);
	assert.equal(rows.get("a").title, "Cheap hotels");
	assert.equal(rows.get("a").messageCount, 4);
	assert.deepEqual(sent.map((s) => s.op), ["put", "put"]);
	assert.equal(sent[1].chat.messages.length, 4);
});

test("a chat a panel shows is merged by that panel, not behind its back", async () => {
	for (const panel of ["merged", "later"]) {
		const { rows, asked } = await world({ chats: [chat("a")], panel, host: () => ({ state: "changed", messages: [user(3, "Cheaper?")] }) });
		await syncChat("a");
		assert.equal(asked[0].id, "a");
		assert.deepEqual(texts(asked[0].messages), ["Cheaper?"]);
		assert.equal(rows.get("a").messages.length, 2, "the worker leaves it to the panel");
		assert.equal(asked.length, panel === "later" ? 1 : 3, "later ends it; the panel's save starts it again");
	}
});

test("an app thread on screen that changes by itself reaches the panel's chat", async () => {
	const { rows } = await world({ chats: [chat("a")] });
	onChats({ type: "chats", event: "changed", chat: "a", messages: [user(3, "From the app"), answer(4, "Yes")] });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(rows.get("a").messages.length, 4);
	onChats({ type: "chats", event: "changed", chat: "../a", messages: [user(5, "Bad id")] });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(rows.get("a").messages.length, 4);
});

test("a host that is older, gone or refuses changes nothing", async () => {
	const { rows } = await world({ chats: [chat("a")], host: () => undefined });
	await syncChat("a");
	assert.equal(rows.get("a").messages.length, 2);
});

test("at connect the host gets the list and the chats it asks for", async () => {
	const { sent } = await world({ chats: [chat("a"), chat("b"), chat("p", { localStudioPrivate: true })], host: (op) => (op.op === "index" ? { want: ["b"] } : { state: "same" }) });
	await resyncChats();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(sent[0].chats.map((c) => c.id), ["a", "b"]);
	assert.deepEqual(sent.slice(1).map((s) => s.chat.id), ["b"]);
});

test("only the extension's own pages can list or open the app's threads", async () => {
	const { listeners, sent } = await world({ host: () => ({ threads: [{ id: "x" }] }) });
	const askFrom = (sender) =>
		new Promise((resolve) => {
			for (const l of listeners) if (l({ type: "local-studio-app-threads", query: "" }, sender, resolve) === true) return;
			resolve("ignored");
		});
	assert.equal(await askFrom({ id: "id", url: "https://evil.example/", tab: { id: 1 } }), "ignored");
	assert.deepEqual(sent, []);
	const { threads } = await askFrom({ id: "id", url: "chrome-extension://id/sidepanel.html" });
	assert.equal(threads.length, 1);
});

test("merge: nothing is dropped or doubled, and nothing goes before the panel's last summary", () => {
	const here = [user(1, "a"), answer(2, "b"), { role: "compaction", cut: 2, timestamp: 3 }, user(5, "c"), answer(6, "d")];
	const app = [user(1, "a"), answer(2, "b"), answer(3, "late"), user(4, "x"), answer(4, "y"), user(5, "c"), answer(6, "d"), user(7, "z")];
	const merged = mergeTurns(here, app);
	assert.deepEqual(texts(merged), ["a", "b", "compaction", "late", "x", "y", "c", "d", "z"]);
	assert.deepEqual(mergeTurns(merged, app), merged, "a second time changes nothing");
	assert.equal(new Set(messageKeys(merged).filter(Boolean)).size, 8);
});

test("long text and large images are cut to size on the way out", () => {
	const [message] = toSession([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "x".repeat(200_010) }, { type: "image", data: "A".repeat(2_800_001), mimeType: "image/png" }] },
	]);
	assert.match(message.content[0].text, /\[10 more characters\]$/);
	assert.deepEqual(message.content[1], { type: "text", text: "[image]" });
});

test("Past chats: the app's threads join by time, and one opened here hides until the app adds to it", () => {
	const thread = (id, modified) => ({ id, title: id, modified, folder: "/Users/d/site", messages: 2, model: "m" });
	const chats = [chat("a", { lastModified: "2026-11-20T10:00:00.000Z", from: { thread: "t1", modified: "2026-11-19T00:00:00.000Z" } })];
	const threads = [thread("t2", "2026-11-21T00:00:00.000Z"), thread("t1", "2026-11-19T00:00:00.000Z")];
	assert.deepEqual(unopened(threads, chats).map((t) => t.id), ["t2"]);
	assert.deepEqual(unopened([thread("t1", "2026-11-22T00:00:00.000Z")], chats).map((t) => t.id), ["t1"]);
	assert.deepEqual(inOrder(chats, threads).map((r) => r.chat?.id ?? r.thread.id), ["t2", "a", "t1"]);
	assert.equal(folderName("/Users/d/site"), "site");
	assert.equal(folderName("C:\\work\\site\\"), "site");
});
