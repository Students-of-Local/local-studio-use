/**
 * The side panel's chats as threads of the Local Studio app, and what the app adds to them back (the native host's half;
 * src/threads/sync.ts is the extension's). A chat is the session `browser-<chat id>` in Eukhe's session store: first a
 * file Eukhe lists at once and imports when the app opens it (`<sid>.jsonl`), from then on Eukhe's own (`<sid>/`), which
 * only the daemon may change. What the app added is never overwritten: a put that finds any is answered "changed".
 *
 * Every field from the extension is checked here. Ids are letters, digits, - and _, so nothing is written outside the two
 * folders, and a link in place of the file or folder is refused. Nothing here runs a model, sends a prompt or answers an
 * approval, and threads the person marked local-only are neither listed nor read.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatsOp, ExtChats, HostChats } from "../../src/bridge/protocol.ts";
import { messageKeys, mergeTurns, type SessionMessage } from "../../src/threads/merge.ts";
import { eukheDir } from "./eukhe.ts";
import { DaemonCalls } from "./eukhe-calls.ts";
import { readSession } from "./eukhe-read.ts";
import { dataDir, writeJsonPrivate } from "./files.ts";

type Row = Record<string, unknown>;

/** What the host remembers of one chat. */
interface Known {
	/** Every message both sides were known to hold at the last write or comparison. */
	keys: string[];
	title: string;
	lastModified: string;
	/** The folder's signature when it was last read. */
	sig?: string;
	/** The app added a message or a name: deleting the chat in the panel leaves the thread. */
	appAdded?: boolean;
	/** Deleted in the app: written again only for a new message. */
	gone?: boolean;
}

interface Chat {
	id: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messages: SessionMessage[];
	/** Keys of every message the panel holds, the ones it keeps to itself included. */
	known: string[];
}

const POLL_MS = 3000;
const STILL_MS = 2000;
const MAX_MESSAGES = 20_000;
const MAX_THREADS = 100;
/** Of one thread read for the panel, newest first. */
const THREAD_BYTES = 4 * 1024 * 1024;
const RESULT_CHARS = 20_000;

const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const chatId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const defined = (keys: (string | undefined)[]): string[] => keys.filter((k): k is string => k !== undefined);
const sidOf = (id: string): string => `browser-${id}`;

/** A problem with the request itself; its words go back to the panel. */
class Refused extends Error {}

/** Where Eukhe keeps sessions, or undefined when Local Studio was never set up here. */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dir = eukheDir(env);
	return dir && existsSync(dir) ? join(dir, "sessions") : undefined;
}

/** The app's own state, for the threads the person keeps local. */
export function appStatePath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
	if (env.LOCAL_STUDIO_DATA_DIR) return join(env.LOCAL_STUDIO_DATA_DIR, "state.json");
	const home = env.HOME || homedir();
	if (platform === "darwin") return join(home, "Library", "Application Support", "Local Studio", "state.json");
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "local-studio", "state.json");
}

export class ChatSync {
	private known: Map<string, Known> | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly send: (frame: HostChats) => void,
		private readonly browser: () => string | undefined,
		private readonly options: { socketPaths?: readonly string[]; pollMs?: number; stillMs?: number; platform?: string } = {},
	) {}

	handle(message: ExtChats): void {
		const { id, op } = message;
		if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
		this.serial(() => this.run(op))
			.then((result) => this.send({ type: "chats", id, result }))
			.catch((err: unknown) =>
				this.send({ type: "chats", id, error: { code: err instanceof Refused ? "bad_params" : "internal", message: err instanceof Error ? err.message : String(err) } }),
			);
	}

	/** The extension went away. */
	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One at a time: two writers of one session could each miss what the other added. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async run(op: ChatsOp): Promise<Row> {
		if (!isRecord(op)) throw new Refused("no operation");
		if ((this.options.platform ?? process.platform) === "win32" || !sessionsDir()) return { state: "no-app" };
		switch (op.op) {
			case "index":
				return this.index(op.chats);
			case "put":
				return this.put(checkedChat(op.chat));
			case "forget":
				if (!chatId(op.id)) throw new Refused("bad chat id");
				return this.forget(op.id);
			case "threads":
				return this.threads(text(op.query, 200));
			case "thread":
				return this.thread(op.id);
			case "off":
				this.stop();
				return { state: "off" };
			default:
				throw new Refused("unknown operation");
		}
	}

	// ---- what is remembered

	private statePath(): string {
		const name = this.browser();
		return join(dataDir(), "chat-sync", `${name && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "default"}.json`);
	}

	private state(): Map<string, Known> {
		if (this.known) return this.known;
		const out = new Map<string, Known>();
		try {
			const raw = JSON.parse(readFileSync(this.statePath(), "utf8")) as unknown;
			if (isRecord(raw) && isRecord(raw.chats))
				for (const [id, v] of Object.entries(raw.chats))
					if (chatId(id) && isRecord(v) && Array.isArray(v.keys) && v.keys.every((k) => typeof k === "string"))
						out.set(id, {
							keys: v.keys as string[],
							title: text(v.title, 500),
							lastModified: text(v.lastModified, 40),
							...(typeof v.sig === "string" ? { sig: v.sig } : {}),
							...(v.appAdded === true ? { appAdded: true } : {}),
							...(v.gone === true ? { gone: true } : {}),
						});
		} catch {
			/* Missing or damaged: every chat is compared again, and nothing is deleted on that account. */
		}
		this.known = out;
		return out;
	}

	private save(): void {
		writeJsonPrivate(this.statePath(), { version: 1, chats: Object.fromEntries(this.state()) });
	}

	// ---- the store

	private paths(id: string): { file: string; folder: string; hasFile: boolean; hasFolder: boolean } {
		const dir = sessionsDir() as string;
		const file = join(dir, `${sidOf(id)}.jsonl`);
		const folder = join(dir, sidOf(id));
		const is = (path: string, kind: "isFile" | "isDirectory"): boolean => {
			try {
				const st = lstatSync(path);
				if (!st[kind]()) throw new Refused(`${path} is not a plain ${kind === "isFile" ? "file" : "folder"}; Local Studio left it alone.`);
				return true;
			} catch (err) {
				if (err instanceof Refused) throw err;
				return false;
			}
		};
		return { file, folder, hasFile: is(file, "isFile"), hasFolder: is(folder, "isDirectory") };
	}

	private chatsDir(): string {
		const dir = join(dataDir(), "chats");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	/** The session file Eukhe lists and imports: a header, the name, then each message. */
	private write(chat: Pick<Chat, "id" | "title" | "createdAt">, messages: readonly Row[]): void {
		const dir = sessionsDir() as string;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const { file } = this.paths(chat.id);
		const started = new Date(Date.parse(chat.createdAt) || Date.now()).toISOString();
		const lines: Row[] = [
			{ type: "session", version: 3, id: sidOf(chat.id), timestamp: started, cwd: this.chatsDir() },
			{ type: "session_info", id: "name", parentId: null, timestamp: started, name: chat.title },
		];
		let parentId = "name";
		messages.forEach((message, i) => {
			const id = `m${i}`;
			const at = typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : started;
			lines.push({ type: "message", id, parentId, timestamp: at, message });
			parentId = id;
		});
		const tmp = join(dir, `.${sidOf(chat.id)}.tmp`);
		rmSync(tmp, { force: true });
		writeFileSync(tmp, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
		renameSync(tmp, file);
	}

	private remember(chat: Chat, more: Partial<Known> = {}): void {
		const before = this.state().get(chat.id);
		const keys = [...new Set([...(before?.keys ?? []), ...defined(messageKeys(chat.messages)), ...chat.known])];
		this.state().set(chat.id, { ...(before?.appAdded ? { appAdded: true } : {}), keys, title: chat.title, lastModified: chat.lastModified, ...more });
		this.save();
		this.poll();
	}

	// ---- panel to app

	private async index(raw: unknown): Promise<Row> {
		if (!Array.isArray(raw) || raw.length > 5000) throw new Refused("bad chat list");
		const now = new Map<string, string>();
		for (const c of raw) if (isRecord(c) && chatId(c.id)) now.set(c.id, text(c.lastModified, 40));
		// An empty list says the panel's store could not be read as likely as that it is empty: nothing is forgotten for it.
		if (now.size > 0) for (const id of [...this.state().keys()]) if (!now.has(id)) await this.forget(id).catch(() => undefined);
		const want = [...now].filter(([id, at]) => this.state().get(id)?.lastModified !== at).map(([id]) => id);
		if (this.state().size > 0) this.poll();
		return { state: "ok", want };
	}

	private async put(chat: Chat): Promise<Row> {
		const { hasFile, hasFolder } = this.paths(chat.id);
		const before = this.state().get(chat.id);
		const keys = defined(messageKeys(chat.messages));
		const fresh = keys.filter((k) => !before?.keys.includes(k));
		if (before && !hasFile && !hasFolder && fresh.length === 0) {
			this.remember(chat, { gone: true });
			return { state: "gone" };
		}
		if (hasFolder) return this.putOpened(chat, keys);
		if (before && hasFile && !before.gone && fresh.length === 0 && before.lastModified === chat.lastModified) {
			return { state: "same" };
		}
		this.write(chat, chat.messages);
		this.remember(chat);
		return { state: "written" };
	}

	/** The app has opened this chat: compare with what it holds, and change its session only when it is idle. */
	private async putOpened(chat: Chat, keys: string[]): Promise<Row> {
		if (this.localOnly(sidOf(chat.id))) return { state: "local-only" };
		try {
			return await this.daemon(async (d) => {
				const before = this.state().get(chat.id);
				const { folder, file } = this.paths(chat.id);
				const row = await this.savedRow(d, chat.id);
				const live = await this.liveRow(d, sidOf(chat.id));
				if (live && running(live)) return { state: "busy" };
				const app = readSession(folder);
				const appKeys = messageKeys(app);
				const seen = new Set([...chat.known, ...keys, ...(before?.keys ?? [])]);
				const extras = app.filter((_, i) => appKeys[i] !== undefined && !seen.has(appKeys[i] as string));
				const appTitle = text(row?.name, 500);
				const renamed = before !== undefined && appTitle !== "" && appTitle !== before.title && chat.title === before.title;
				if (extras.length > 0 || renamed) {
					this.added(chat.id, chat, folder);
					return { state: "changed", messages: forPanel(extras), ...(renamed ? { title: appTitle } : {}) };
				}
				const have = new Set([...defined(appKeys), ...(before?.keys ?? [])]);
				if (keys.every((k) => have.has(k))) {
					if (appTitle !== chat.title) await this.rename(d, chat, folder, live).catch(() => undefined);
					this.remember(chat, this.mark(folder));
					return { state: "same" };
				}
				// Only a session at rest is written anew, and only if nothing was saved since it was read.
				if (live) await d.call({ type: "kill", activeSessionId: live.activeSessionId });
				const now = defined(messageKeys(readSession(folder)));
				if (now.length !== defined(appKeys).length) return { state: "busy" };
				await d.call({ type: "delete_saved_session", sessionPath: folder });
				if (existsSync(folder)) return { state: "busy" };
				rmSync(file, { force: true });
				// The app's own copy of a message is kept whole: it can hold what the panel's has not.
				const own = new Map(app.map((m, i) => [appKeys[i], m] as const));
				const dropped = new Set((before?.keys ?? []).filter((k) => !chat.known.includes(k) && !keys.includes(k)));
				const kept = app.filter((_, i) => appKeys[i] !== undefined && !dropped.has(appKeys[i] as string));
				const merged = mergeTurns(
					chat.messages.map((m, i) => own.get(messageKeys(chat.messages)[i]) ?? m),
					kept as SessionMessage[],
				);
				this.write(chat, withAppRows(merged as Row[], app, appKeys));
				this.remember(chat);
				return { state: "written" };
			});
		} catch (err) {
			if (err instanceof Refused) throw err;
			// No daemon, or it went away halfway: tried again after the next change.
			return { state: "busy" };
		}
	}

	private async rename(d: DaemonCalls, chat: Chat, folder: string, live: Row | undefined): Promise<void> {
		if (live) await d.call({ type: "set_session_name", activeSessionId: live.activeSessionId, name: chat.title });
		else await d.call({ type: "rename_saved_session", sessionPath: folder, name: chat.title });
	}

	private async forget(id: string): Promise<Row> {
		const entry = this.state().get(id);
		if (!entry) return { state: "unknown" };
		const { file, folder, hasFile, hasFolder } = this.paths(id);
		let state = "kept";
		if (!hasFolder) {
			if (hasFile) rmSync(file, { force: true });
			state = "deleted";
		} else if (!entry.appAdded) {
			state = await this.daemon(async (d) => {
				const live = await this.liveRow(d, sidOf(id));
				if (live && running(live)) return "kept";
				if (defined(messageKeys(readSession(folder))).some((k) => !entry.keys.includes(k))) return "kept";
				if (live) await d.call({ type: "kill", activeSessionId: live.activeSessionId });
				await d.call({ type: "delete_saved_session", sessionPath: folder });
				if (!existsSync(folder)) rmSync(file, { force: true });
				return existsSync(folder) ? "kept" : "deleted";
			}).catch(() => "kept");
		}
		this.state().delete(id);
		this.save();
		return { state };
	}

	// ---- app to panel

	private poll(): void {
		this.timer ??= setInterval(() => {
			void this.serial(() => this.look()).catch(() => undefined);
		}, this.options.pollMs ?? POLL_MS);
		this.timer.unref?.();
	}

	/** Chats whose session the app changed and left still: what it added goes to the panel. */
	private async look(): Promise<void> {
		if (!sessionsDir()) return;
		const changed: { id: string; folder: string; sig: string }[] = [];
		for (const [id, entry] of this.state()) {
			const found = signature(join(sessionsDir() as string, sidOf(id)));
			if (found && found.sig !== entry.sig && Date.now() - found.at >= (this.options.stillMs ?? STILL_MS)) changed.push({ id, folder: join(sessionsDir() as string, sidOf(id)), sig: found.sig });
		}
		if (changed.length === 0) return;
		// Without a daemon nothing runs, and a name can't have changed.
		const { rows, live } = await this.daemon(async (d) => ({ rows: await this.savedRows(d, "current"), live: await this.liveRows(d) })).catch(() => ({ rows: [], live: [] }));
		for (const { id, folder, sig } of changed) {
			const entry = this.state().get(id);
			const open = live.find((r) => r.sessionId === sidOf(id));
			if (!entry || this.localOnly(sidOf(id)) || (open && running(open))) continue;
			const name = text(rows.find((r) => r.id === sidOf(id))?.name, 500);
			const title = name && name !== entry.title ? name : undefined;
			let extras: Row[] = [];
			try {
				const app = readSession(folder);
				const keys = messageKeys(app);
				extras = app.filter((_, i) => keys[i] !== undefined && !entry.keys.includes(keys[i] as string));
			} catch {
				continue;
			}
			this.added(id, undefined, folder, extras.length > 0 || title !== undefined);
			if (extras.length > 0 || title) this.send({ type: "chats", event: "changed", chat: id, messages: forPanel(extras), ...(title ? { title } : {}) });
			else this.state().set(id, { ...(this.state().get(id) as Known), sig });
		}
		this.save();
	}

	/** Note what the app's session looks like now. The keys stay: the panel holds the new messages only once it puts them. */
	private added(id: string, chat: Chat | undefined, folder: string, byApp = true): void {
		const entry = this.state().get(id) ?? { keys: [], title: chat?.title ?? "", lastModified: "" };
		this.state().set(id, { ...entry, ...this.mark(folder), ...(byApp ? { appAdded: true } : {}), gone: undefined });
		this.save();
		this.poll();
	}

	private mark(folder: string): Partial<Known> {
		const sig = signature(folder)?.sig;
		return sig ? { sig } : {};
	}

	// ---- the app's own threads

	private async threads(query: string): Promise<Row> {
		const own = new Set([...this.state().keys()].map(sidOf));
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		try {
			const rows = await this.daemon((d) => this.savedRows(d, null));
			const threads = rows
				.filter((r) => typeof r.id === "string" && !own.has(r.id) && !(Number(r.rlmDepth) > 0) && Number(r.messageCount) > 0 && !this.localOnly(r.id))
				.filter((r) => {
					if (words.length === 0) return true;
					const hay = `${String(r.name ?? "")}\n${String(r.cwd ?? "")}\n${String(r.allMessagesText ?? "")}`.toLowerCase();
					return words.every((w) => hay.includes(w));
				})
				.sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")))
				.slice(0, MAX_THREADS)
				.map((r) => ({
					id: r.id,
					title: text(r.name, 200) || text(r.firstMessage, 120) || "Thread",
					modified: text(r.modified, 40),
					folder: text(r.cwd, 1024),
					messages: Number(r.messageCount),
					model: isRecord(r.model) ? text(r.model.modelId, 120) : "",
				}));
			return { state: "ok", threads };
		} catch {
			return { state: "no-app" };
		}
	}

	private async thread(raw: unknown): Promise<Row> {
		const id = text(raw, 200);
		const found = await this.daemon(async (d) => {
			const row = (await this.savedRows(d, null)).find((r) => r.id === id);
			if (!row || Number(row.rlmDepth) > 0 || this.localOnly(id)) return undefined;
			return { row, messages: readSession(text(row.path, 4096)) };
		});
		if (!found) throw new Refused("No such Local Studio thread.");
		return { state: "ok", title: text(found.row.name, 200) || text(found.row.firstMessage, 120) || "Thread", folder: text(found.row.cwd, 1024), messages: newest(forPanel(found.messages)) };
	}

	/** Did the person keep this thread on this computer's models only? An app state that can't be read says yes. */
	private localOnly(sid: unknown): boolean {
		if (typeof sid !== "string") return true;
		const path = appStatePath();
		if (!existsSync(path)) return false;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
			const threads = isRecord(raw) && isRecord(raw.threads) ? raw.threads : {};
			const thread = threads[sid];
			return isRecord(thread) && thread.localOnly !== undefined && thread.localOnly !== null && thread.localOnly !== false;
		} catch {
			return true;
		}
	}

	// ---- daemon

	private daemon<T>(fn: (d: DaemonCalls) => Promise<T>): Promise<T> {
		return DaemonCalls.with(fn, this.options.socketPaths);
	}

	private async savedRows(d: DaemonCalls, scope: "current" | null): Promise<Row[]> {
		const { sessions } = await d.call({ type: "list_saved_sessions", cwd: this.chatsDir(), scope });
		return Array.isArray(sessions) ? sessions.filter(isRecord) : [];
	}

	private async savedRow(d: DaemonCalls, id: string): Promise<Row | undefined> {
		return (await this.savedRows(d, "current")).find((r) => r.id === sidOf(id));
	}

	private async liveRows(d: DaemonCalls): Promise<Row[]> {
		const { sessions } = await d.call({ type: "list" });
		return Array.isArray(sessions) ? sessions.filter(isRecord) : [];
	}

	private async liveRow(d: DaemonCalls, sid: string): Promise<Row | undefined> {
		return (await this.liveRows(d)).find((r) => r.sessionId === sid);
	}
}

/** Is the app's session doing anything, or holding input it has not run? */
function running(row: Row): boolean {
	const queued = isRecord(row.sessionActions) ? Number(row.sessionActions.queuedCount) : 0;
	return [row.isStreaming, row.isCompacting, row.isRunningTools, row.isBashRunning, row.hasRunningSubagents].some((v) => v === true) || queued > 0;
}

/** The rows only the app keeps (its notices) back behind the message each followed. */
function withAppRows(messages: readonly Row[], app: readonly Row[], appKeys: readonly (string | undefined)[]): Row[] {
	const after = new Map<string, Row[]>();
	let last = "";
	app.forEach((row, i) => {
		if (appKeys[i] !== undefined) last = appKeys[i] as string;
		else after.set(last, [...(after.get(last) ?? []), row]);
	});
	const keys = messageKeys(messages);
	return [...(after.get("") ?? []), ...messages.flatMap((m, i) => [m, ...(after.get(keys[i] ?? "-") ?? [])])];
}

/** The newest time and the sizes of a session folder's records, or undefined when there is none. */
function signature(folder: string): { sig: string; at: number } | undefined {
	try {
		if (!lstatSync(folder).isDirectory()) return undefined;
		let at = 0;
		let size = 0;
		for (const name of readdirSync(folder)) {
			if (!name.endsWith(".jsonl")) continue;
			const st = lstatSync(join(folder, name));
			at = Math.max(at, st.mtimeMs);
			size += st.size;
		}
		return { sig: `${at}:${size}`, at };
	} catch {
		return undefined;
	}
}

function checkedChat(raw: unknown): Chat {
	if (!isRecord(raw) || !chatId(raw.id)) throw new Refused("bad chat id");
	if (!Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) throw new Refused("bad messages");
	const messages = raw.messages.filter(
		(m): m is SessionMessage => isRecord(m) && ["user", "assistant", "toolResult"].includes(String(m.role)) && Array.isArray(m.content) && typeof m.timestamp === "number" && Number.isFinite(new Date(m.timestamp).getTime()),
	);
	if (messages.length !== raw.messages.length || messages.length === 0) throw new Refused("bad messages");
	const known = Array.isArray(raw.known) ? raw.known.filter((k): k is string => typeof k === "string" && k.length <= 300).slice(0, MAX_MESSAGES) : [];
	const oneLine = text(raw.title, 500).replace(/\s+/g, " ").trim();
	return { id: raw.id, title: oneLine || "Browser chat", createdAt: text(raw.createdAt, 40), lastModified: text(raw.lastModified, 40), messages, known };
}

/** The app's messages as the panel may store them: text and tool calls, no images, reasoning or tool details. */
function forPanel(messages: readonly Row[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	for (const m of messages) {
		if (typeof m.timestamp !== "number" || (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult")) continue;
		if (m.role === "toolResult" && typeof m.toolCallId !== "string") continue;
		const max = m.role === "toolResult" ? RESULT_CHARS : 200_000;
		const blocks: unknown[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
		const content: Row[] = [];
		for (const b of blocks) {
			if (!isRecord(b)) continue;
			if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text.length > max ? `${b.text.slice(0, max)}\n[cut]` : b.text });
			else if (b.type === "image") content.push({ type: "text", text: "[image]" });
			else if (b.type === "toolCall" && m.role === "assistant" && typeof b.id === "string" && typeof b.name === "string") content.push({ type: "toolCall", id: b.id, name: b.name, arguments: isRecord(b.arguments) ? b.arguments : {} });
		}
		const base = { role: m.role, content, timestamp: m.timestamp } as SessionMessage;
		if (m.role === "toolResult") out.push({ ...base, toolCallId: m.toolCallId as string, toolName: text(m.toolName, 200) || "tool", isError: m.isError === true });
		else if (m.role === "assistant")
			out.push({
				...base,
				api: text(m.api, 100) || "openai-completions",
				provider: text(m.provider, 100) || "unknown",
				model: text(m.model, 200) || "unknown",
				usage: isRecord(m.usage) && isRecord(m.usage.cost) ? m.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: text(m.stopReason, 20) || "stop",
				...(typeof m.errorMessage === "string" ? { errorMessage: text(m.errorMessage, 2000) } : {}),
			});
		else out.push(base);
	}
	return out;
}

/** The newest messages that fit, starting at a user message. */
function newest(messages: SessionMessage[]): SessionMessage[] {
	let size = 0;
	let from = messages.length;
	while (from > 0) {
		size += Buffer.byteLength(JSON.stringify(messages[from - 1]));
		if (size > THREAD_BYTES) break;
		from--;
	}
	const cut = messages.slice(from);
	const first = from === 0 ? 0 : cut.findIndex((m) => m.role === "user");
	return first > 0 ? cut.slice(first) : cut;
}
