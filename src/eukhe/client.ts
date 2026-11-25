/**
 * Side panel side of the Local Studio chats: one port to the background relay (relay.ts), requests answered by id and a
 * daemon's events delivered to the chat they belong to.
 */

import { EUKHE_PORT, type EukheReply, type EukheRequest } from "./types.js";

export class EukheRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "EukheRequestError";
	}
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

let port: chrome.runtime.Port | undefined;
let seq = 0;
const waiters = new Map<number, Waiter>();
const listeners = new Map<string, Set<(frame: Record<string, unknown>) => void>>();

function deliver(conversation: string, frame: Record<string, unknown>): void {
	for (const listener of listeners.get(conversation) ?? []) listener(frame);
}

function connect(): chrome.runtime.Port {
	if (port) return port;
	const next = chrome.runtime.connect({ name: EUKHE_PORT });
	next.onMessage.addListener((reply: EukheReply) => {
		if (reply.id !== undefined) {
			const w = waiters.get(reply.id);
			if (!w) return;
			waiters.delete(reply.id);
			clearTimeout(w.timer);
			if (reply.error) w.reject(new EukheRequestError(reply.error.code, reply.error.message));
			else w.resolve(reply.result ?? {});
			return;
		}
		if (reply.event) deliver(reply.conversation, reply.event);
		if (reply.closed)
			deliver(reply.conversation, {
				type: "session_closed",
				reason: "the connection to the Local Studio app closed",
			});
	});
	next.onDisconnect.addListener(() => {
		if (port === next) port = undefined;
		for (const w of waiters.values()) {
			clearTimeout(w.timer);
			w.reject(new EukheRequestError("no_host", "Lost the connection to Local Studio's background worker."));
		}
		waiters.clear();
		for (const conversation of listeners.keys())
			deliver(conversation, { type: "session_closed", reason: "the panel lost its background worker" });
	});
	port = next;
	return next;
}

/** One request to the host's Eukhe relay; rejects with EukheRequestError (eukhe_unavailable when no daemon runs). */
export function eukheRequest<T = Record<string, unknown>>(
	op: EukheRequest["op"],
	conversation: string,
	command?: Record<string, unknown>,
	timeoutMs?: number,
): Promise<T> {
	const id = ++seq;
	return new Promise<T>((resolve, reject) => {
		const w: Waiter = { resolve: resolve as (value: unknown) => void, reject };
		if (timeoutMs)
			w.timer = setTimeout(() => {
				waiters.delete(id);
				reject(new EukheRequestError("timeout", "The Local Studio app did not answer in time."));
			}, timeoutMs);
		waiters.set(id, w);
		connect().postMessage({ id, op, conversation, ...(command ? { command } : {}) } satisfies EukheRequest);
	});
}

/** The daemon's frames for one chat, until the returned function is called. */
export function onEukheFrames(conversation: string, listener: (frame: Record<string, unknown>) => void): () => void {
	let set = listeners.get(conversation);
	if (!set) {
		set = new Set();
		listeners.set(conversation, set);
	}
	set.add(listener);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(conversation);
	};
}
