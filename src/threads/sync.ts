/**
 * One set of chats in the side panel and the Local Studio app (service worker side; cli/src/chat-sync.ts holds the app's
 * side). A chat that changed and is at rest is sent; what the app added comes back and is put into the chat by the panel
 * that shows it, else here. Private chats and older unmarked ones are never sent (store.ts agentsMayRead), keys pasted into
 * a chat are removed (session.ts). Settings > Privacy turns it off; what the app has then stays there as its own threads.
 */

import type { ChatsOp, ExtChats, HostChats } from "../bridge/protocol.js";
import { redactSecrets } from "../privacy/bug-reports.js";
import { isExtensionPage } from "../subscriptions/relay-protocol.js";
import { APP_THREADS, CHAT_MERGE, THREAD_CHANGED } from "./events.js";
import { CHAT_SYNC_KEY } from "./keys.js";
import { mergeTurns, messageKeys, roleOf, type SessionMessage } from "./merge.js";
import { scheduleMirror } from "./mirror.js";
import { validThreadId } from "./render.js";
import { toSession } from "./session.js";
import { agentsMayRead, changeThread, listThreadMeta, readThread, SHARE_OLDER_KEY } from "./store.js";

/** Quiet time before a changed chat is sent. */
export const SYNC_QUIET_MS = 2000;
const BUSY_MS = 30_000;
const ANSWER_MS = 60_000;
/** How long an open panel has to say it has the chat. */
const PANEL_MS = 1000;

type Answer = Record<string, unknown> & { state?: string };

let send: (message: ExtChats) => boolean = () => false;
const waiting = new Map<number, (answer: Answer | undefined) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

export async function chatSyncOn(): Promise<boolean> {
	const data = await chrome.storage.local.get(CHAT_SYNC_KEY).catch(() => ({}) as Record<string, unknown>);
	return (data as Record<string, unknown>)[CHAT_SYNC_KEY] !== false;
}

/** Ask the host; undefined when there is none, it is older than this, or it refused. */
function ask(op: ChatsOp): Promise<Answer | undefined> {
	const id = ++seq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => waiting.get(id)?.(undefined), ANSWER_MS);
		waiting.set(id, (answer) => {
			clearTimeout(timer);
			waiting.delete(id);
			resolve(answer);
		});
		if (!send({ type: "chats", id, op })) waiting.get(id)?.(undefined);
	});
}

/** A frame from the host, or "disconnected" when it went. */
export function onChats(message: HostChats | "disconnected"): void {
	if (message === "disconnected") {
		for (const done of [...waiting.values()]) done(undefined);
		return;
	}
	if (message.id !== undefined) waiting.get(message.id)?.(message.error ? undefined : (message.result as Answer));
	else if (message.event === "changed" && validThreadId(message.chat ?? "")) {
		const { chat, messages, title } = message;
		serial(async () => {
			if ((await chatSyncOn()) && (await put(chat as string, messages ?? [], title)))
				later(chat as string, SYNC_QUIET_MS);
		});
	}
}

function serial(run: () => Promise<unknown>): void {
	queue = queue.then(run, run).catch(() => undefined);
}

function later(id: string, ms: number): void {
	clearTimeout(timers.get(id));
	timers.set(
		id,
		setTimeout(() => {
			timers.delete(id);
			serial(() => syncChat(id));
		}, ms),
	);
}

/** At rest: the last thing said is an answer that asks for no tool. */
export function atRest(messages: readonly unknown[]): boolean {
	const said = messages.filter((m): m is Record<string, unknown> => !!roleOf((m ?? {}) as Record<string, unknown>));
	const last = said[said.length - 1];
	if (last?.role !== "assistant" || !said.some((m) => roleOf(m) === "user")) return false;
	if (last.stopReason === "aborted" || last.stopReason === "error") return true;
	return !(Array.isArray(last.content) && last.content.some((c) => (c as { type?: unknown })?.type === "toolCall"));
}

/** Send one chat, and put in what the app answers with, until the two sides agree. */
export async function syncChat(id: string): Promise<void> {
	if (!validThreadId(id) || !(await chatSyncOn())) return;
	for (let round = 0; round < 3; round++) {
		const { meta, data } = await readThread(id);
		if (!meta || !data || !(await agentsMayRead())(meta, data)) {
			await ask({ op: "forget", id });
			return;
		}
		if (!atRest(data.messages)) return;
		const messages = toSession(data.messages);
		const answer = await ask({
			op: "put",
			chat: {
				id,
				title: redactSecrets(meta.title || data.title || ""),
				createdAt: meta.createdAt,
				lastModified: meta.lastModified,
				messages,
				known: messageKeys(data.messages).filter((k): k is string => k !== undefined),
			},
		});
		if (answer?.state === "busy") return later(id, BUSY_MS);
		if (answer?.state !== "changed") return;
		if (!(await put(id, (answer.messages ?? []) as SessionMessage[], answer.title as string | undefined))) return;
	}
}

/** Put the app's messages in. False when an open panel will do it once its run ends, or the chat is gone. */
async function put(id: string, messages: SessionMessage[], title: string | undefined): Promise<boolean> {
	const panel = await askPanels(id, messages, title);
	if (panel) return panel === "merged";
	const wrote = await changeThread(id, (meta, data) => {
		const merged = mergeTurns(data.messages, messages);
		const name = title ?? meta.title;
		const now = new Date().toISOString();
		return {
			meta: { ...meta, title: name, messageCount: merged.length, lastModified: now },
			data: { ...data, title: name, messages: merged, lastModified: now },
		};
	});
	if (wrote) scheduleMirror(id);
	return wrote;
}

function askPanels(id: string, messages: SessionMessage[], title?: string): Promise<"merged" | "later" | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), PANEL_MS);
		const done = (answer: unknown) => {
			clearTimeout(timer);
			resolve(answer === "merged" || answer === "later" ? answer : undefined);
		};
		Promise.resolve(chrome.runtime.sendMessage({ type: CHAT_MERGE, id, messages, title })).then(done, () =>
			done(undefined),
		);
	});
}

/** A host connected: tell it every chat, send the ones it lacks, and forget the rest. */
export async function resyncChats(): Promise<void> {
	if (!(await chatSyncOn())) return;
	const may = await agentsMayRead();
	const chats = (await listThreadMeta()).filter((m) => validThreadId(m.id) && may(m)).slice(0, 500);
	const answer = await ask({ op: "index", chats: chats.map((m) => ({ id: m.id, lastModified: m.lastModified })) });
	for (const id of Array.isArray(answer?.want) ? (answer.want as string[]) : []) serial(() => syncChat(id));
}

/** Wire the sync into the worker. `sender` posts to the native host (false when there is none). */
export function startChatSync(sender: (message: ExtChats) => boolean): void {
	send = sender;
	const origin = chrome.runtime.getURL("");
	chrome.runtime.onMessage?.addListener((message, sender, reply) => {
		if (message?.type === THREAD_CHANGED && typeof message.id === "string") later(message.id, SYNC_QUIET_MS);
		if (message?.type !== APP_THREADS || !isExtensionPage(sender, origin)) return undefined;
		const op: ChatsOp =
			typeof message.thread === "string"
				? { op: "thread", id: message.thread }
				: { op: "threads", query: String(message.query ?? "") };
		void chatSyncOn().then(async (on) => reply(on ? ((await ask(op)) ?? {}) : {}));
		return true;
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !(CHAT_SYNC_KEY in changes || SHARE_OLDER_KEY in changes)) return;
		if (changes[CHAT_SYNC_KEY]?.newValue === false) void ask({ op: "off" });
		else serial(resyncChats);
	});
}
