/**
 * open_settings and offer_buttons (src/links/worker.ts): an agent opens a settings place for the person, or puts buttons
 * above the side panel's chat that the person can click. Remote sessions need the `user.ask` scope.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeClient, BridgeRpcError } from "./client.ts";
import { OFFER_LINKS_MAX, OFFER_NOTE_MAX } from "../../src/links/types.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** One call to the extension, as the model reads it. Exported for tests. */
export async function linksCall(client: BridgeClient, method: "open_settings" | "offer_buttons", params: Record<string, unknown>): Promise<ToolResult> {
	const say = (text: string, isError?: boolean): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
	try {
		// No retry: a retry after a dropped bridge would open it twice.
		const reply = (await client.call(method, params, 15_000, { retry: false })) as { done?: unknown };
		return say(typeof reply?.done === "string" ? reply.done : "Done.");
	} catch (err) {
		if (err instanceof BridgeRpcError && err.rpc.code === "not_found") return say("This Local Studio extension doesn't have this yet. Ask the user to update Local Studio.", true);
		if (err instanceof BridgeRpcError) return say(`${err.rpc.code}: ${err.rpc.message}`, true);
		return say(err instanceof Error ? err.message : String(err), true);
	}
}

export function registerLinks(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"open_settings",
		{
			title: "Open a settings page",
			description: 'Open a settings page for the user; it changes nothing. A wrong place is answered with the list. Example: {"place":"system/displays"}',
			inputSchema: { place: z.string().max(100).describe("settings/<section> of Local Studio, browser/<page> or system/<pane> of the computer") },
		},
		(args) => linksCall(client, "open_settings", { place: args.place }),
	);
	server.registerTool(
		"offer_buttons",
		{
			title: "Offer buttons",
			description: 'Show buttons in the side panel that act on the user\'s computer when the user clicks them. Example: {"links":["localstudio://file?path=/Users/me/report.pdf"],"note":"Your report"}',
			inputSchema: {
				links: z.array(z.string().max(4096)).min(1).max(OFFER_LINKS_MAX).describe("localstudio://<an open_settings place>, app/<name>, shortcut/<name> (macOS), file?path=<document or folder> or reveal?path=<any file>; percent-encoded"),
				note: z.string().max(OFFER_NOTE_MAX).optional().describe("Why"),
			},
		},
		(args) => linksCall(client, "offer_buttons", { links: args.links, ...(args.note ? { note: args.note } : {}) }),
	);
}
