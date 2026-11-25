/**
 * The side panel's "Local Studio" provider, the parts with no browser in them: which Eukhe models it lists and how they
 * are labeled, the text one turn sends, and how the daemon's session events become the panel's stream events. The
 * daemon side is cli/src/eukhe.ts; the stream that drives a turn is stream.ts.
 */

import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, TextContent } from "@mariozechner/pi-ai";
import { isLocalBaseUrl } from "../privacy/private-mode.js";

export const LOCAL_STUDIO_PROVIDER = "local-studio";
/** The pi-ai api whose stream runs a turn in a Eukhe session (stream.ts). */
export const LOCAL_STUDIO_API = "eukhe-session";

/** A model as Eukhe's get_available_models lists it (eukhe-types ai::Model), the fields read here. */
export interface EukheModel {
	id: string;
	name?: string;
	provider: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** Eukhe's `/login` subscriptions, by its provider id. */
const SIGN_INS: Record<string, string> = {
	"openai-codex": "ChatGPT plan",
	anthropic: "Claude sign-in",
	"github-copilot": "Copilot plan",
	xai: "Grok sign-in",
};

/** Provider ids Eukhe uses for models served on this machine or the local network (models.json). */
const LOCAL_PROVIDERS = new Set([
	"llamacpp",
	"llama.cpp",
	"ollama",
	"lmstudio",
	"vllm",
	"sglang",
	"local",
	"local-fleet",
]);

/** A private-network address (RFC 1918, or a tailnet's 100.64.0.0/10): a model served on the person's own network. */
function isNetworkBaseUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	const p = host.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return host.endsWith(".local");
	return (
		p[0] === 10 ||
		(p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
		(p[0] === 192 && p[1] === 168) ||
		(p[0] === 100 && p[1] >= 64 && p[1] <= 127)
	);
}

/** Where a model runs: this machine, the person's network, or a provider through a sign-in. */
function placement(m: EukheModel): "local" | "network" | "remote" {
	if (SIGN_INS[m.provider]) return "remote";
	if (m.baseUrl && isLocalBaseUrl(m.baseUrl)) return "local";
	if (m.baseUrl && isNetworkBaseUrl(m.baseUrl)) return "network";
	return LOCAL_PROVIDERS.has(m.provider) ? "local" : "remote";
}

/** A model that runs on this machine or the person's own network, not at a provider. */
export function isLocalEukheModel(m: EukheModel): boolean {
	return placement(m) !== "remote";
}

/** What the picker shows after the model's name. */
export function eukheModelLabel(m: EukheModel): string {
	const where = placement(m);
	if (where === "local") return "local";
	if (where === "network") return "local network";
	return SIGN_INS[m.provider] ?? `${m.provider}, through Local Studio`;
}

/** The panel's id for a Eukhe model: `<eukhe provider>/<eukhe model id>` (provider ids hold no slash). */
export function panelModelId(m: EukheModel): string {
	return `${m.provider}/${m.id}`;
}

/** The Eukhe provider and model id behind a panel model id. */
export function eukheTarget(panelId: string): { provider: string; model: string } {
	const cut = panelId.indexOf("/");
	return cut < 0
		? { provider: panelId, model: panelId }
		: { provider: panelId.slice(0, cut), model: panelId.slice(cut + 1) };
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The picker's models: local ones first, then the signed-in subscriptions, each labeled, in the daemon's order within
 * each group. The base URL is the model's real one, so private mode judges where prompts really go.
 */
export function panelModels(models: readonly EukheModel[]): Model<Api>[] {
	const valid = models.filter((m) => m && typeof m.id === "string" && typeof m.provider === "string");
	const ordered = [...valid.filter(isLocalEukheModel), ...valid.filter((m) => !isLocalEukheModel(m))];
	return ordered.map(
		(m): Model<Api> => ({
			id: panelModelId(m),
			name: `${m.name || m.id} (${eukheModelLabel(m)})`,
			api: LOCAL_STUDIO_API as Api,
			provider: LOCAL_STUDIO_PROVIDER,
			baseUrl: m.baseUrl || "http://127.0.0.1",
			reasoning: Boolean(m.reasoning),
			// Text only: a turn sends Eukhe text (turnPrompt), so the composer must not take an image it would drop.
			input: ["text"],
			cost: NO_COST,
			contextWindow: m.contextWindow || 32768,
			maxTokens: m.maxTokens || 8192,
		}),
	);
}

/** The text of a user message, with the panel's own context notes cut to the tab they name. */
function userText(content: Context["messages"][number]["content"]): string {
	const text =
		typeof content === "string"
			? content
			: (content as Array<{ type: string; text?: string }>)
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n");
	if (!text.includes("<browser-context>")) return text;
	// A navigation note (message-transformer.ts): keep the tab's title and URL, not the skills list after them.
	const title = text.match(/Navigation succeeded: (.*)/)?.[1]?.trim();
	const url = text.match(/URL: (\S+)/)?.[1];
	return url ? `Current tab: ${title ? `${title} ` : ""}${url}` : "";
}

/**
 * What one turn sends to the Eukhe session: the user's messages since the last answer. A session made for a chat that
 * already has turns (the panel reloaded) gets the earlier turns first, as plain text.
 */
export function turnPrompt(context: Context, freshSession: boolean): string {
	const messages = context.messages;
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--)
		if (messages[i].role === "assistant") {
			last = i;
			break;
		}
	const now = messages
		.slice(last + 1)
		.filter((m) => m.role === "user")
		.map((m) => userText(m.content))
		.filter(Boolean)
		.join("\n\n");
	if (!freshSession || last < 0) return now;
	const earlier = messages
		.slice(0, last + 1)
		.flatMap((m) => {
			if (m.role === "user") {
				const t = userText(m.content);
				return t ? [`User: ${t}`] : [];
			}
			if (m.role === "assistant") {
				const t = m.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("");
				return t ? [`Assistant: ${t}`] : [];
			}
			return [];
		})
		.join("\n\n");
	return earlier ? `Earlier in this chat:\n\n${earlier}\n\nNow:\n\n${now}` : now;
}

/** A short line for a tool's arguments in its step. */
function argsLine(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const text = JSON.stringify(args);
	return text === "{}" ? "" : ` ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

/** What a tool result was, in a few words. */
function resultLine(result: unknown, isError: boolean): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	const images = content.filter((c) => c.type === "image").length;
	const what = [
		text ? (text.length > 200 ? `${text.slice(0, 197)}...` : text) : "",
		images ? `${images} image(s)` : "",
	]
		.filter(Boolean)
		.join(", ");
	return `${isError ? "Failed" : "Done"}${what ? `: ${what}` : ""}`;
}

/**
 * Turns Eukhe session events into the panel's stream events. Text deltas become text, thinking deltas thinking, and each
 * tool the session runs becomes a step (a thinking block whose first line names the tool), so the transcript shows it
 * and the panel's agent never tries to run it: Eukhe ran it already.
 */
export class EukheTurn {
	readonly output: AssistantMessage;
	private block: { type: "text"; text: string } | { type: "thinking"; thinking: string } | undefined;
	/** A tool step is its own block; the next text starts a new one. */
	private stepOpen = false;
	ended = false;
	/** Set when the person pressed stop: the run's end is an abort, not an answer. */
	aborting = false;
	error: string | undefined;

	constructor(
		model: Model<Api>,
		private readonly push: (event: AssistantMessageEvent) => void,
	) {
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...NO_COST, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	private index(): number {
		return this.output.content.length - 1;
	}

	private close(): void {
		const b = this.block;
		if (!b) return;
		this.push(
			b.type === "text"
				? { type: "text_end", contentIndex: this.index(), content: b.text, partial: this.output }
				: { type: "thinking_end", contentIndex: this.index(), content: b.thinking, partial: this.output },
		);
		this.block = undefined;
		this.stepOpen = false;
	}

	private append(kind: "text" | "thinking", delta: string): void {
		if (!delta) return;
		if (this.block?.type !== kind || this.stepOpen) {
			this.close();
			this.block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			this.output.content.push(this.block as never);
			this.push({
				type: kind === "text" ? "text_start" : "thinking_start",
				contentIndex: this.index(),
				partial: this.output,
			});
		}
		const b = this.block;
		if (b.type === "text") b.text += delta;
		else b.thinking += delta;
		this.push({
			type: kind === "text" ? "text_delta" : "thinking_delta",
			contentIndex: this.index(),
			delta,
			partial: this.output,
		});
	}

	/** A tool step: its own thinking block, whose first line is the summary the transcript shows. */
	private step(text: string, extend = false): void {
		if (extend && this.stepOpen && this.block?.type === "thinking") {
			this.block.thinking += `\n${text}`;
			this.push({ type: "thinking_delta", contentIndex: this.index(), delta: `\n${text}`, partial: this.output });
			return;
		}
		this.close();
		this.append("thinking", text);
		this.stepOpen = true;
	}

	/** Take one frame the relay passed on (a daemon session_event, session_closed, or the host's shell_refused). */
	take(frame: Record<string, unknown>): void {
		if (this.ended) return;
		if (frame.type === "shell_refused") {
			this.step(`Shell step refused: the side panel runs no shell commands (${String(frame.command ?? "")})`);
			return;
		}
		if (frame.type === "session_closed") {
			this.fail(`Local Studio closed the session (${String(frame.reason ?? "closed")}).`);
			return;
		}
		if (frame.type !== "session_event") return;
		const ev = (frame.event ?? {}) as Record<string, unknown>;
		switch (ev.type) {
			case "message_update": {
				const change = (ev.assistantMessageEvent ?? {}) as { type?: string; delta?: string };
				if (change.type === "text_delta") this.append("text", change.delta ?? "");
				else if (change.type === "thinking_delta") this.append("thinking", change.delta ?? "");
				return;
			}
			case "tool_execution_start":
				this.step(`Ran ${String(ev.toolName)}${argsLine(ev.args)}`);
				return;
			case "tool_execution_end":
				this.step(resultLine(ev.result, ev.isError === true), true);
				this.close();
				return;
			case "turn_end":
				if (typeof ev.error === "string" && ev.error) this.error = ev.error;
				return;
			case "agent_end":
				this.finish(this.aborting);
				return;
		}
	}

	/** The run ended: a done event, or an error one if the turn failed. */
	finish(aborted = false): void {
		if (this.ended) return;
		if (aborted) {
			this.fail("Stopped.", true);
			return;
		}
		if (this.error) {
			this.fail(this.error);
			return;
		}
		this.close();
		this.ended = true;
		this.output.stopReason = "stop";
		this.push({ type: "done", reason: "stop", message: this.output });
	}

	fail(message: string, aborted = false): void {
		if (this.ended) return;
		this.close();
		this.ended = true;
		this.output.stopReason = aborted ? "aborted" : "error";
		this.output.errorMessage = message;
		this.push({ type: "error", reason: aborted ? "aborted" : "error", error: this.output });
	}
}
