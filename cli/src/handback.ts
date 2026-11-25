/**
 * tabs_show {"wait":true}: hand a tab to the user and wait for Continue (src/handback/state.ts has the flow). The tab
 * is not brought forward; the side panel and the veil's pill say "Your turn" with a Continue button, and the call
 * returns when the user presses it, takes the tab back, closes it, or the wait times out.
 */

import { randomUUID } from "node:crypto";
import { HANDBACK_TIMEOUT_MS, type HandbackOutcome } from "../../src/handback/state.ts";
import { type BridgeClient, BridgeRpcError, isConnectionError, NOT_CONNECTED } from "./client.ts";
import { envVar } from "./env.ts";

/** How often a waiting call reports progress (tests shorten it). */
const PROGRESS_EVERY_MS = Number(envVar("ASK_PROGRESS_MS")) || 15_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface Extra {
	signal: AbortSignal;
	_meta?: { progressToken?: string | number };
	sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
}

/** The bridge's reply, or its failure, as the model reads it. Exported for tests. */
export function handbackResultText(reply: unknown, err?: unknown): ToolResult {
	if (err === undefined) {
		const r = reply as Partial<HandbackOutcome>;
		if (typeof r?.text === "string" && typeof r.status === "string") return { content: [{ type: "text", text: r.text }] };
		return { content: [{ type: "text", text: "Local Studio returned an unexpected reply to tabs_show." }], isError: true };
	}
	if (err instanceof BridgeRpcError) {
		if (err.rpc.code === "not_found")
			return {
				content: [{ type: "text", text: "This Local Studio extension can't wait for the user yet. Call tabs_show without wait, and ask the user in the chat to tell you when they are done." }],
				isError: true,
			};
		return { content: [{ type: "text", text: `${err.rpc.code}: ${err.rpc.message}` }], isError: true };
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/timed out after/.test(message)) return { content: [{ type: "text", text: "No Continue from the user in time. Ask them whether they finished before you go on." }] };
	if (message === NOT_CONNECTED || isConnectionError(err)) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
	return { content: [{ type: "text", text: message }], isError: true };
}

export async function waitForUser(client: BridgeClient, args: { tabId?: number; reason?: string; username_ref?: string; password_ref?: string }, extra: Extra): Promise<ToolResult> {
	const token = extra._meta?.progressToken;
	let ticks = 0;
	const startedAt = Date.now();
	// Waiting minutes is normal here. Clients that reset their timeout on progress keep waiting.
	const progress =
		token === undefined
			? undefined
			: setInterval(() => {
					extra
						.sendNotification({
							method: "notifications/progress",
							params: {
								progressToken: token,
								progress: ++ticks,
								message: `Waiting for the user to press Continue in Local Studio (${Math.max(0, Math.ceil((HANDBACK_TIMEOUT_MS - (Date.now() - startedAt)) / 60000))} min left)`,
							},
						})
						.catch(() => undefined);
				}, PROGRESS_EVERY_MS);
	// The agent gave up on the call: take the card off the user's screen.
	const waitId = randomUUID();
	const onAbort = () => void client.call("handback.cancel", { waitId }, 5000, { retry: false }).catch(() => undefined);
	extra.signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (!client.connected) await client.connect();
		if (!client.extensionConnected) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
		// No retry: a retry after a dropped bridge would show the user a second card.
		const { tabId, reason, username_ref: username, password_ref: password } = args;
		const signIn = username || password ? { username, password } : undefined;
		const reply = await client.call("handback", { tabId, reason, signIn, waitId }, HANDBACK_TIMEOUT_MS + 30_000, { retry: false });
		return handbackResultText(reply);
	} catch (err) {
		return handbackResultText(undefined, err);
	} finally {
		clearInterval(progress);
		extra.signal.removeEventListener("abort", onAbort);
	}
}
