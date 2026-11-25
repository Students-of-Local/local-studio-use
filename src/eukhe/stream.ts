/**
 * The side panel's "Local Studio" provider: each panel chat is a Eukhe session in Local Studio's daemon, reached through
 * the native host (cli/src/eukhe.ts). The extension holds no key. The daemon runs the model (a local one, or a
 * subscription signed in with `eukhe /login`) and its own tools; the browser tools come back to this extension through
 * the `local-studio-browser` MCP entry `local-studio-browser install --local-studio` writes.
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	registerModels,
	resetProviderModels,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { EukheRequestError, eukheRequest, onEukheFrames } from "./client.js";
import {
	type EukheModel,
	EukheTurn,
	eukheTarget,
	isLocalEukheModel,
	LOCAL_STUDIO_API,
	LOCAL_STUDIO_PROVIDER,
	panelModels,
	turnPrompt,
} from "./models.js";

export { LOCAL_STUDIO_PROVIDER } from "./models.js";

/** How long the panel waits to learn whether Local Studio runs; the host answers eukhe_unavailable within 1.5 s. */
const PROBE_MS = 2500;
/** How long an aborted turn may take to wind down before the panel stops waiting. */
const ABORT_WAIT_MS = 3000;

let reachable: boolean | undefined;
let lastModels: Model<Api>[] = [];
let lastLocal = new Set<string>();

export function isLocalStudioProvider(provider: string): boolean {
	return provider === LOCAL_STUDIO_PROVIDER;
}

/** What the last look found: true when the host reached a running Eukhe daemon. */
export function localStudioReachable(): boolean | undefined {
	return reachable;
}

export function localStudioModels(): Model<Api>[] {
	return lastModels;
}

/** Ask the host whether Local Studio's daemon runs. */
export async function probeLocalStudio(): Promise<boolean> {
	try {
		await eukheRequest("probe", "probe", undefined, PROBE_MS);
		reachable = true;
	} catch {
		reachable = false;
	}
	return reachable;
}

/**
 * The models Local Studio can run now (local ones first, then the signed-in subscriptions), registered under the "Local
 * Studio" provider for the model picker. Listing needs a session, so a throwaway one is made and ended.
 */
export function refreshLocalStudioModels(): Promise<Model<Api>[]> {
	// One look at a time: two would share the host's "models" conversation, and the first to close it would end the other.
	refreshing ??= listModels().finally(() => {
		refreshing = undefined;
	});
	return refreshing;
}
let refreshing: Promise<Model<Api>[]> | undefined;

async function listModels(): Promise<Model<Api>[]> {
	if (!(await probeLocalStudio())) {
		lastModels = [];
		resetProviderModels(LOCAL_STUDIO_PROVIDER);
		return lastModels;
	}
	const conversation = "models";
	try {
		const created = await eukheRequest<{ activeSessionId?: string }>(
			"command",
			conversation,
			{ type: "create", noSession: true, config: {} },
			PROBE_MS * 4,
		);
		const session = created.activeSessionId;
		if (!session) throw new Error("Local Studio opened no session.");
		const listed = await eukheRequest<{ models?: EukheModel[] }>(
			"command",
			conversation,
			{ type: "get_available_models", activeSessionId: session },
			PROBE_MS * 4,
		);
		void eukheRequest("command", conversation, { type: "kill", activeSessionId: session }).catch(() => undefined);
		const models = listed.models ?? [];
		lastLocal = new Set(models.filter(isLocalEukheModel).map((m) => `${m.provider}/${m.id}`));
		lastModels = panelModels(models);
		registerModels(LOCAL_STUDIO_PROVIDER, lastModels);
	} catch (err) {
		console.warn("[local-studio] models unavailable:", err);
		lastModels = [];
		resetProviderModels(LOCAL_STUDIO_PROVIDER);
	} finally {
		void eukheRequest("close", conversation).catch(() => undefined);
	}
	return lastModels;
}

/** One panel chat's Eukhe session. */
interface ChatSession {
	id: string;
	model: string;
}
const sessions = new Map<string, Promise<ChatSession>>();

/** One chat's name across turns: its first user message (time and text) and the system prompt. */
async function conversationKey(context: Context): Promise<string> {
	const first = context.messages.find((m) => m.role === "user");
	const seed = JSON.stringify([context.systemPrompt ?? "", first?.timestamp ?? 0, first?.content ?? ""]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
	return `chat-${[...new Uint8Array(digest)]
		.slice(0, 12)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

/** The chat's session, made (and attached, so its events come here) on its first turn; a new model is switched to. */
async function chatSession(
	conversation: string,
	panelModelId: string,
): Promise<{ session: ChatSession; fresh: boolean }> {
	const { provider, model } = eukheTarget(panelModelId);
	const existing = sessions.get(conversation);
	if (existing) {
		try {
			const session = await existing;
			if (session.model !== panelModelId) {
				await eukheRequest("command", conversation, {
					type: "set_model",
					activeSessionId: session.id,
					provider,
					modelId: model,
				});
				session.model = panelModelId;
			}
			return { session, fresh: false };
		} catch {
			sessions.delete(conversation);
		}
	}
	const local = lastLocal.has(panelModelId);
	const made = (async (): Promise<ChatSession> => {
		const created = await eukheRequest<{ activeSessionId?: string }>("command", conversation, {
			type: "create",
			noSession: true,
			config: { provider, model },
			// A local model gets the small browser tool list (D53); the installed `local-studio-browser` MCP entry asks for it too.
			...(local ? { env: { LOCAL_STUDIO_BROWSER_PROFILE: "small" } } : {}),
		});
		if (!created.activeSessionId) throw new Error("Local Studio opened no session.");
		await eukheRequest("command", conversation, { type: "attach", activeSessionId: created.activeSessionId });
		return { id: created.activeSessionId, model: panelModelId };
	})();
	sessions.set(conversation, made);
	try {
		return { session: await made, fresh: true };
	} catch (err) {
		sessions.delete(conversation);
		throw err;
	}
}

export function streamLocalStudio(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const turn = new EukheTurn(model, (event) => stream.push(event));
	(async () => {
		let stop: (() => void) | undefined;
		try {
			const conversation = await conversationKey(context);
			// This turn's run starts at the first agent_start after its prompt went out. Events before that are an earlier
			// run's: one stopped here that was still winding down when this message was sent.
			let prompted = false;
			let started = false;
			// Listen first: the daemon streams the turn as soon as the prompt is accepted.
			const ended = new Promise<void>((resolve) => {
				stop = onEukheFrames(conversation, (frame) => {
					// The session is gone (Local Studio restarted, the host was respawned): the next turn makes a new one.
					if (frame.type === "session_closed") sessions.delete(conversation);
					if (frame.type === "session_event") {
						if (!prompted) return;
						if (!started) {
							if ((frame.event as { type?: string } | undefined)?.type !== "agent_start") return;
							started = true;
						}
					}
					turn.take(frame);
					if (turn.ended) resolve();
				});
			});
			if (options?.signal?.aborted) {
				turn.finish(true);
				return;
			}
			// Stopped while a session was being made: the abort listener would never hear it, so no prompt goes out. A new
			// session that never got a prompt is ended and dropped, so the chat's next turn starts over with its earlier turns.
			const stoppedBeforePrompt = (made: { session: ChatSession; fresh: boolean }): boolean => {
				if (!options?.signal?.aborted && !turn.aborting) return false;
				if (made.fresh) {
					sessions.delete(conversation);
					void eukheRequest("command", conversation, { type: "kill", activeSessionId: made.session.id }).catch(
						() => undefined,
					);
				}
				turn.finish(true);
				return true;
			};
			const first = await chatSession(conversation, model.id);
			let session = first.session;
			if (turn.ended) return;
			if (stoppedBeforePrompt(first)) return;
			const abort = () => {
				turn.aborting = true;
				void eukheRequest("command", conversation, { type: "abort", activeSessionId: session.id }).catch(
					() => undefined,
				);
				setTimeout(() => turn.finish(true), ABORT_WAIT_MS);
			};
			options?.signal?.addEventListener("abort", abort, { once: true });
			stream.push({ type: "start", partial: turn.output });
			/** False when the run was stopped before a prompt went out. */
			const prompt = async (retry: boolean): Promise<boolean> => {
				const made = await chatSession(conversation, model.id);
				const { session: current, fresh } = made;
				session = current;
				if (stoppedBeforePrompt(made)) return false;
				prompted = true;
				try {
					await eukheRequest("command", conversation, {
						type: "prompt",
						activeSessionId: current.id,
						message: turnPrompt(context, fresh),
					});
				} catch (err) {
					// A session from an earlier turn may be gone with its daemon connection: once, start over in a new one,
					// which gets the chat's earlier turns.
					if (fresh || !retry || turn.ended) throw err;
					sessions.delete(conversation);
					prompted = false;
					return prompt(false);
				}
				return true;
			};
			if (!(await prompt(true))) {
				options?.signal?.removeEventListener("abort", abort);
				return;
			}
			await ended;
			options?.signal?.removeEventListener("abort", abort);
			if (options?.signal?.aborted && turn.output.stopReason !== "aborted") turn.output.stopReason = "aborted";
		} catch (err) {
			const message =
				err instanceof EukheRequestError || err instanceof Error
					? err.message
					: `Local Studio failed: ${String(err)}`;
			turn.fail(message, options?.signal?.aborted === true);
		} finally {
			stop?.();
			stream.end();
		}
	})();
	return stream;
}

let registered = false;

/** Register the Local Studio api with pi-ai once. */
export function registerLocalStudioApi(): void {
	if (registered) return;
	registered = true;
	registerApiProvider({
		api: LOCAL_STUDIO_API as Api,
		stream: streamLocalStudio,
		streamSimple: streamLocalStudio,
	});
}
