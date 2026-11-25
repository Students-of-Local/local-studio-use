/** Messages between the side panel and the background's Local Studio relay (relay.ts). */

export const EUKHE_PORT = "local-studio-eukhe";

/** side panel -> background */
export interface EukheRequest {
	id: number;
	conversation: string;
	op: "probe" | "command" | "close";
	command?: Record<string, unknown>;
}

/** background -> side panel: an answer (`id`), or a daemon event for one chat (`event`), or its end (`closed`). */
export interface EukheReply {
	id?: number;
	conversation: string;
	result?: unknown;
	error?: { code: string; message: string };
	event?: Record<string, unknown>;
	closed?: boolean;
}
