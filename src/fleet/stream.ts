import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	parseStreamingJson,
	registerApiProvider,
	registerModels,
	resetProviderModels,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "@mariozechner/pi-ai";
import { EukheRequestError, eukheRequest, onEukheFrames } from "../eukhe/client.js";

export const LOCAL_STUDIO_PROVIDER = "local-studio";
const FLEET_API = "local-studio-fleet";
const LIST_MS = 6000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type FleetState =
	| { state: "checking" | "down" }
	| { state: "ready"; count: number }
	| { state: "unauthorized"; path?: string; fix?: string };

let lastModels: Model<Api>[] = [];
let last: FleetState = { state: "checking" };
let refreshing: Promise<Model<Api>[]> | undefined;

export function isLocalStudioProvider(provider: string): boolean {
	return provider === LOCAL_STUDIO_PROVIDER;
}

export function isStaleLocalModel(model: Model<Api>): boolean {
	return isLocalStudioProvider(model.provider) && model.api !== FLEET_API;
}

export function currentFleetModel(model: Model<Api>, listed: readonly Model<Api>[]): Model<Api> | undefined {
	return listed.find((m) => m.id === model.id) ?? listed[0];
}

export function localStudioModels(): Model<Api>[] {
	return lastModels;
}

export function fleetState(): FleetState {
	return last;
}

function name(): string {
	return `fleet-${crypto.randomUUID()}`;
}

export function panelModels(ids: readonly string[], base: string): Model<Api>[] {
	const real = ids.filter((id) => id !== "auto");
	const listed = real.length && ids.includes("auto") ? [...real, "auto"] : real;
	return listed.map(
		(id): Model<Api> => ({
			id,
			name: id === "auto" ? "Auto (the controller picks a running model)" : `${id} (local)`,
			api: FLEET_API as Api,
			provider: LOCAL_STUDIO_PROVIDER,
			baseUrl: base,
			reasoning: false,
			input: ["text"],
			cost: NO_COST,
			contextWindow: 32768,
			maxTokens: 8192,
		}),
	);
}

async function listModels(): Promise<Model<Api>[]> {
	const conversation = name();
	try {
		const listed = await eukheRequest<{ base?: string; models?: Array<{ id: string }> }>(
			"fleet_models",
			conversation,
			undefined,
			LIST_MS,
		);
		lastModels = panelModels(
			(listed.models ?? []).map((m) => m.id),
			listed.base ?? "http://127.0.0.1:18091/v1",
		);
		last = { state: "ready", count: lastModels.filter((m) => m.id !== "auto").length };
	} catch (err) {
		lastModels = [];
		const e = err instanceof EukheRequestError ? err : undefined;
		const text = (v: unknown) => (typeof v === "string" ? v : undefined);
		last =
			e?.code === "fleet_unauthorized"
				? { state: "unauthorized", path: text(e.detail.path), fix: text(e.detail.fix) }
				: { state: "down" };
	} finally {
		void eukheRequest("close", conversation).catch(() => undefined);
	}
	if (lastModels.length) registerModels(LOCAL_STUDIO_PROVIDER, lastModels);
	else resetProviderModels(LOCAL_STUDIO_PROVIDER);
	return lastModels;
}

export function refreshLocalStudioModels(): Promise<Model<Api>[]> {
	last = { state: "checking" };
	refreshing ??= listModels().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}

const texts = (content: readonly { type: string; text?: string }[]): string =>
	content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

export function chatBody(model: Model<Api>, context: Context): Record<string, unknown> {
	const messages: Record<string, unknown>[] = [];
	if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
	for (const m of context.messages) {
		if (m.role === "user")
			messages.push({ role: "user", content: typeof m.content === "string" ? m.content : texts(m.content) });
		else if (m.role === "assistant") {
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			const calls = m.content.flatMap((c) =>
				c.type === "toolCall"
					? [{ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }]
					: [],
			);
			const text = texts(m.content);
			if (!text && !calls.length) continue;
			messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
		} else messages.push({ role: "tool", tool_call_id: m.toolCallId, content: texts(m.content) || "(no text)" });
	}
	const tools = (context.tools ?? []).map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
	return {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...(tools.length ? { tools } : {}),
	};
}

interface Delta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
	tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}
interface Chunk {
	choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function streamFleet(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...NO_COST, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const conversation = name();
	let block: TextContent | ThinkingContent | (ToolCall & { partial: string; index: number }) | undefined;
	const at = () => output.content.length - 1;
	const close = () => {
		if (!block) return;
		if (block.type === "text")
			stream.push({ type: "text_end", contentIndex: at(), content: block.text, partial: output });
		else if (block.type === "thinking")
			stream.push({ type: "thinking_end", contentIndex: at(), content: block.thinking, partial: output });
		else {
			const { partial, index, ...call } = block;
			call.arguments = parseStreamingJson(partial) ?? {};
			output.content[at()] = call;
			stream.push({ type: "toolcall_end", contentIndex: at(), toolCall: call, partial: output });
		}
		block = undefined;
	};
	const say = (kind: "text" | "thinking", delta: string) => {
		if (block?.type !== kind) {
			close();
			block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
			output.content.push(block);
			stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: at(), partial: output });
		}
		if (block.type === "text") block.text += delta;
		else if (block.type === "thinking") block.thinking += delta;
		stream.push({
			type: kind === "text" ? "text_delta" : "thinking_delta",
			contentIndex: at(),
			delta,
			partial: output,
		});
	};
	const take = (chunk: Chunk) => {
		if (chunk.usage) {
			output.usage.input = chunk.usage.prompt_tokens ?? 0;
			output.usage.output = chunk.usage.completion_tokens ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.output;
		}
		const choice = chunk.choices?.[0];
		if (!choice) return;
		const d = choice.delta ?? {};
		if (d.content) say("text", d.content);
		const thought = d.reasoning_content || d.reasoning;
		if (thought) say("thinking", thought);
		for (const t of d.tool_calls ?? []) {
			const index = t.index ?? 0;
			if (block?.type !== "toolCall" || block.index !== index) {
				close();
				block = { type: "toolCall", id: t.id ?? `call_${index}`, name: "", arguments: {}, partial: "", index };
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: at(), partial: output });
			}
			if (t.function?.name) block.name = t.function.name;
			const piece = t.function?.arguments ?? "";
			block.partial += piece;
			stream.push({ type: "toolcall_delta", contentIndex: at(), delta: piece, partial: output });
		}
		if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
		else if (choice.finish_reason === "length") output.stopReason = "length";
	};
	(async () => {
		let stop: (() => void) | undefined;
		const cancel = () => void eukheRequest("close", conversation).catch(() => undefined);
		try {
			const ended = new Promise<void>((resolve, reject) => {
				stop = onEukheFrames(conversation, (frame) => {
					if (frame.type === "fleet_chunk") take(frame.chunk as Chunk);
					else if (frame.type === "fleet_end") resolve();
					else if (frame.type === "fleet_error") reject(new Error(String(frame.message)));
					else if (frame.type === "session_closed")
						reject(new Error("Lost the connection to Local Studio's helper."));
				});
			});
			ended.catch(() => undefined);
			options?.signal?.addEventListener("abort", cancel, { once: true });
			const aborted = new Promise<never>((_, reject) =>
				options?.signal?.addEventListener("abort", () => reject(new Error("Stopped.")), { once: true }),
			);
			aborted.catch(() => undefined);
			if (options?.signal?.aborted) throw new Error("Stopped.");
			await Promise.race([eukheRequest("fleet_chat", conversation, chatBody(model, context)), aborted]);
			stream.push({ type: "start", partial: output });
			await Promise.race([ended, aborted]);
			close();
			if (output.content.some((c) => c.type === "toolCall")) output.stopReason = "toolUse";
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		} catch (err) {
			close();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			options?.signal?.removeEventListener("abort", cancel);
			stop?.();
			cancel();
			stream.end();
		}
	})();
	return stream;
}

let registered = false;

export function registerLocalStudioApi(): void {
	if (registered) return;
	registered = true;
	registerApiProvider({ api: FLEET_API as Api, stream: streamFleet, streamSimple: streamFleet });
}
