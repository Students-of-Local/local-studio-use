/**
 * Side panel chats as the Local Studio app keeps them. The app's threads are pi-ai messages in Eukhe's session store, so a panel
 * chat becomes the user, assistant and toolResult messages of it; what only the panel has (page notes, artifacts,
 * summaries, reasoning) stays in the panel. The way back is cut to size by the host (cli/src/chat-sync.ts).
 */

import { redactSecrets } from "../privacy/bug-reports.js";
import { isRecord, roleOf, type SessionMessage, timeOf } from "./merge.js";

type Loose = Record<string, unknown>;

const TEXT_CHARS = 200_000;
const IMAGE_CHARS = 2_800_000; // about 2 MB of bytes
const IMAGES_CHARS = 11_000_000; // about 8 MB a chat
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function clip(text: string): string {
	return text.length > TEXT_CHARS
		? `${text.slice(0, TEXT_CHARS)}\n[${text.length - TEXT_CHARS} more characters]`
		: text;
}

const textBlock = (text: string) => ({ type: "text", text: clip(redactSecrets(text)) });

/** The chat's messages for the app, oldest first. Secrets are redacted; reasoning and panel-only rows stay behind. */
export function toSession(messages: readonly unknown[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	let images = 0;
	const image = (data: unknown, mimeType: unknown): Loose => {
		const size = typeof data === "string" ? data.length : 0;
		if (!size || size > IMAGE_CHARS || images + size > IMAGES_CHARS || typeof mimeType !== "string")
			return { type: "text", text: "[image]" };
		images += size;
		return { type: "image", data, mimeType };
	};
	for (const raw of messages) {
		if (!isRecord(raw)) continue;
		const role = roleOf(raw);
		const timestamp = timeOf(raw);
		if (!role || timestamp === undefined) continue;
		const blocks: unknown[] = typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : [];
		if (Array.isArray(raw.content)) blocks.push(...raw.content);
		const content: Loose[] = [];
		for (const b of blocks) {
			if (!isRecord(b)) continue;
			if (b.type === "text" && typeof b.text === "string") content.push(textBlock(b.text));
			else if (b.type === "image")
				content.push(role === "user" ? image(b.data, b.mimeType) : { type: "text", text: "[image]" });
			else if (
				b.type === "toolCall" &&
				role === "assistant" &&
				typeof b.id === "string" &&
				typeof b.name === "string"
			)
				content.push({ type: "toolCall", id: b.id, name: b.name, arguments: redacted(b.arguments) });
		}
		if (raw.role === "user-with-attachments" && Array.isArray(raw.attachments))
			for (const a of raw.attachments) {
				if (!isRecord(a)) continue;
				const name = typeof a.fileName === "string" ? a.fileName : "file";
				if (a.type === "image") content.push(image(a.content, a.mimeType));
				else
					content.push(
						textBlock(`[attached: ${name}]${typeof a.extractedText === "string" ? `\n${a.extractedText}` : ""}`),
					);
			}
		if (content.length === 0) {
			// An assistant message with only reasoning, or an error: the app needs a block to show.
			if (role === "assistant" && typeof raw.errorMessage === "string")
				content.push(textBlock(`[error: ${raw.errorMessage}]`));
			else if (role === "toolResult") content.push({ type: "text", text: "" });
			else continue;
		}
		if (role === "user") out.push({ role, content, timestamp });
		else if (role === "toolResult") {
			if (typeof raw.toolCallId !== "string") continue;
			const toolName = typeof raw.toolName === "string" ? raw.toolName : "tool";
			out.push({ role, toolCallId: raw.toolCallId, toolName, content, isError: raw.isError === true, timestamp });
		} else
			out.push({
				role,
				content,
				api: typeof raw.api === "string" ? raw.api : "openai-completions",
				provider: typeof raw.provider === "string" ? raw.provider : "unknown",
				model: typeof raw.model === "string" ? raw.model : "unknown",
				usage: isRecord(raw.usage) ? raw.usage : NO_USAGE,
				stopReason: typeof raw.stopReason === "string" ? raw.stopReason : "stop",
				timestamp,
			});
	}
	return out;
}

function redacted(args: unknown): unknown {
	try {
		return JSON.parse(redactSecrets(JSON.stringify(args ?? {}))) as unknown;
	} catch {
		return {};
	}
}
