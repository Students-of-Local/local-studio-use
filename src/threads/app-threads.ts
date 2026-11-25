/** The Local Studio app's own threads in the side panel: listed beside the panel's chats, opened as a chat that goes on from there. */

import { getAppStorage, type SessionMetadata } from "@mariozechner/pi-web-ui";
import type { ChatMarks } from "../storage/stores/sessions-store.js";
import { APP_THREADS } from "./events.js";
import type { SessionMessage } from "./merge.js";

export interface AppThread {
	id: string;
	title: string;
	modified: string;
	folder: string;
	messages: number;
	model: string;
}

type Chat = SessionMetadata & ChatMarks;

/** The app's threads, newest first; none without Local Studio, its helper, or with the sync off. */
export async function appThreads(query = ""): Promise<AppThread[]> {
	const answer = await chrome.runtime.sendMessage({ type: APP_THREADS, query }).catch(() => undefined);
	return Array.isArray(answer?.threads) ? (answer.threads as AppThread[]) : [];
}

/** Threads that show beside `chats`: one opened here already shows again only once the app has added to it. */
export function unopened(threads: readonly AppThread[], chats: readonly SessionMetadata[]): AppThread[] {
	const opened = new Map<string, string>();
	for (const { from } of chats as Chat[])
		if (from && (opened.get(from.thread) ?? "") < from.modified) opened.set(from.thread, from.modified);
	return threads.filter((t) => (opened.get(t.id) ?? "") < t.modified);
}

/** Chats and threads as one list, newest first. */
export function inOrder(
	chats: readonly SessionMetadata[],
	threads: readonly AppThread[],
): ({ chat: SessionMetadata } | { thread: AppThread })[] {
	const at = (row: { chat: SessionMetadata } | { thread: AppThread }) =>
		Date.parse("chat" in row ? row.chat.lastModified : row.thread.modified) || 0;
	return [...chats.map((chat) => ({ chat })), ...threads.map((thread) => ({ thread }))].sort((a, b) => at(b) - at(a));
}

/** The folder's own name, for a row's second line. */
export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** A chat of the panel's own that holds the thread's messages; the thread itself stays as it is. The new chat's id. */
export async function openAppThread(
	thread: AppThread,
	model: unknown,
	thinkingLevel: SessionMetadata["thinkingLevel"],
): Promise<string> {
	const answer = await chrome.runtime.sendMessage({ type: APP_THREADS, thread: thread.id });
	const messages = answer?.messages as SessionMessage[] | undefined;
	if (!messages?.length) throw new Error("Local Studio didn't answer. Check that it is running, then try again.");
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const title = thread.title;
	const metadata: Chat = {
		id,
		title,
		createdAt: now,
		lastModified: now,
		messageCount: messages.length,
		usage,
		thinkingLevel,
		preview: "",
		from: { thread: thread.id, modified: thread.modified },
	};
	await getAppStorage().sessions.save(
		{ id, title, model, thinkingLevel, messages, createdAt: now, lastModified: now } as never,
		metadata,
	);
	return id;
}
