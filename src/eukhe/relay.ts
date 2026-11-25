/**
 * Background worker: carries the side panel's Local Studio chats to the native host and the daemon's answers and events
 * back (cli/src/eukhe.ts holds the daemon side). Only Local Studio's own pages may use it, never a content script or a web
 * page. Each panel port gets its own conversation names, so two panels never reach each other's Eukhe sessions; the
 * host is the authority on which commands run.
 */

import { hostCommandText } from "../bridge/host-command.js";
import { onEukheMessage, sendEukhe } from "../bridge/native.js";
import type { HostEukhe } from "../bridge/protocol.js";
import { isExtensionPage } from "../subscriptions/relay-protocol.js";
import { EUKHE_PORT, type EukheReply, type EukheRequest } from "./types.js";

export function startEukheRelay(): void {
	/** host request id -> the panel port and the panel's id */
	const waiting = new Map<number, { port: chrome.runtime.Port; id: number }>();
	/** host conversation name -> the panel port and the panel's name for it */
	const conversations = new Map<string, { port: chrome.runtime.Port; name: string }>();
	let seq = 0;
	let ports = 0;
	onEukheMessage((message: HostEukhe | "disconnected") => {
		if (message === "disconnected") {
			for (const w of waiting.values())
				w.port.postMessage({
					id: w.id,
					conversation: "",
					error: { code: "no_host", message: "Local Studio's native host disconnected. Try again." },
				} satisfies EukheReply);
			waiting.clear();
			for (const c of conversations.values())
				c.port.postMessage({ conversation: c.name, closed: true } satisfies EukheReply);
			conversations.clear();
			return;
		}
		const conv = conversations.get(message.conversation);
		if (message.id !== undefined) {
			const w = waiting.get(message.id);
			if (!w) return;
			waiting.delete(message.id);
			w.port.postMessage({
				id: w.id,
				conversation: conv?.name ?? "",
				...(message.error ? { error: message.error } : { result: message.result }),
			} satisfies EukheReply);
			return;
		}
		if (!conv) return;
		conv.port.postMessage({
			conversation: conv.name,
			...(message.event ? { event: message.event } : {}),
			...(message.closed ? { closed: true } : {}),
		} satisfies EukheReply);
		if (message.closed) conversations.delete(message.conversation);
	});
	const origin = chrome.runtime.getURL("");
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== EUKHE_PORT) return;
		if (!isExtensionPage(port.sender, origin)) {
			port.disconnect();
			return;
		}
		const prefix = `p${++ports}:`;
		const mine = new Set<string>();
		port.onMessage.addListener((raw: unknown) => {
			const req = raw as Partial<EukheRequest>;
			if (typeof req?.id !== "number" || typeof req.conversation !== "string" || !req.conversation) return;
			if (req.op !== "probe" && req.op !== "command" && req.op !== "close") return;
			const conversation = `${prefix}${req.conversation}`.slice(0, 200);
			conversations.set(conversation, { port, name: req.conversation });
			mine.add(conversation);
			const hostId = ++seq;
			waiting.set(hostId, { port, id: req.id });
			const command =
				req.command && typeof req.command === "object" && !Array.isArray(req.command) ? req.command : undefined;
			if (!sendEukhe({ type: "eukhe", id: hostId, conversation, op: req.op, ...(command ? { command } : {}) })) {
				waiting.delete(hostId);
				port.postMessage({
					id: req.id,
					conversation: req.conversation,
					error: {
						code: "no_host",
						message: `Local Studio's native host isn't connected. Run ${hostCommandText("setup")}, then try again.`,
					},
				} satisfies EukheReply);
			}
		});
		port.onDisconnect.addListener(() => {
			for (const [hostId, w] of waiting) if (w.port === port) waiting.delete(hostId);
			// The panel closed: its chats' daemon connections close, and their client-owned sessions end.
			for (const conversation of mine) {
				conversations.delete(conversation);
				sendEukhe({ type: "eukhe", id: ++seq, conversation, op: "close" });
			}
		});
	});
}
