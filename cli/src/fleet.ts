import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtEukhe, HostEukhe, RpcError } from "../../src/bridge/protocol.ts";
import { ERR } from "../../src/bridge/protocol.ts";

export const FLEET_OPS: ReadonlySet<string> = new Set(["fleet_models", "fleet_chat"]);
const LIST_MS = 4000;

export function fleetBase(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.LOCAL_STUDIO_FLEET_URL) return env.LOCAL_STUDIO_FLEET_URL.replace(/\/+$/, "");
	return controllerUrl(fleetConfig(fleetKeyPath(env, home)).url) ?? "http://127.0.0.1:18091/v1";
}

function controllerUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !URL.canParse(raw)) return undefined;
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}

export function fleetKeyPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.LOCAL_STUDIO_CONTROLLER_HOME) return join(env.LOCAL_STUDIO_CONTROLLER_HOME, "config.json");
	const fresh = join(home, ".local-studio-controller");
	const legacy = join(home, ".local-studio-t3", "config.json");
	return !existsSync(fresh) && existsSync(legacy) ? legacy : join(fresh, "config.json");
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function fleetConfig(path: string): { fleetKey?: unknown; url?: unknown } {
	if (!existsSync(path)) return {};
	const config = parse(readFileSync(path, "utf8"));
	return config && typeof config === "object" ? config : {};
}

function fleetKey(path: string): string | undefined {
	const key = fleetConfig(path).fleetKey;
	return typeof key === "string" && key ? key : undefined;
}

export function keyFix(path: string, platform: string = process.platform): RpcError & { path: string; fix?: string } {
	return {
		code: "fleet_unauthorized",
		message: `Fleet key not found: the controller refused the key in ${path}.`,
		path,
		...(platform === "linux" ? { fix: "systemctl --user restart local-studio-controller" } : {}),
	};
}

interface Options {
	env?: NodeJS.ProcessEnv;
	home?: string;
}

export class FleetRelay {
	private readonly chats = new Map<string, AbortController>();
	private readonly seen = new Set<string>();

	constructor(
		private readonly send: (frame: HostEukhe) => void,
		private readonly options: Options = {},
	) {}

	has(conversation: string): boolean {
		return this.seen.has(conversation);
	}

	handle(message: ExtEukhe): void {
		const { id, conversation, op } = message;
		if (op === "close") {
			this.close(conversation);
			this.seen.delete(conversation);
			this.reply(conversation, id, { result: { closed: true } });
			return;
		}
		this.seen.add(conversation);
		if (op === "fleet_models") {
			void this.models(conversation, id);
			return;
		}
		const body = message.command;
		if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string") {
			this.reply(conversation, id, { error: { code: ERR.BAD_PARAMS, message: "fleet_chat needs a chat request with a model" } });
			return;
		}
		void this.chat(conversation, id, body);
	}

	private reply(conversation: string, id: number, answer: { result?: unknown; error?: RpcError }): void {
		this.send({ type: "eukhe", conversation, id, ...answer });
	}

	private event(conversation: string, event: Record<string, unknown>): void {
		this.send({ type: "eukhe", conversation, event });
	}

	private async call(path: string, init: RequestInit): Promise<Response | RpcError> {
		const env = this.options.env ?? process.env;
		const keyPath = fleetKeyPath(env, this.options.home);
		const key = fleetKey(keyPath);
		const base = fleetBase(env, this.options.home);
		let response: Response;
		try {
			response = await fetch(`${base}${path}`, {
				...init,
				headers: { ...(init.headers as Record<string, string>), ...(key ? { authorization: `Bearer ${key}` } : {}) },
				redirect: "error",
			});
		} catch (err) {
			if ((err as Error).name === "AbortError") return { code: "aborted", message: "Stopped." };
			return { code: "fleet_unreachable", message: `Local models aren't running: nothing answered at ${base}.` };
		}
		if (!response.ok) {
			const text = await response.text().catch((err: Error) => err.message);
			const said = parse(text) as { error?: { code?: unknown; message?: unknown } } | undefined;
			if (response.status === 401 && said?.error?.code === "UNAUTHORIZED") return keyFix(keyPath);
			const why = typeof said?.error?.message === "string" ? said.error.message : text.slice(0, 300);
			return { code: "fleet_error", message: `The controller answered ${response.status}${why ? `: ${why}` : ""}` };
		}
		return response;
	}

	private async models(conversation: string, id: number): Promise<void> {
		const answer = await this.call("/models", { signal: AbortSignal.timeout(LIST_MS) });
		if (!(answer instanceof Response)) return this.reply(conversation, id, { error: answer });
		try {
			const body = (await answer.json()) as { data?: Array<{ id?: unknown }> };
			const models = (body.data ?? []).flatMap((m) => (typeof m?.id === "string" ? [{ id: m.id }] : []));
			this.reply(conversation, id, { result: { base: fleetBase(this.options.env, this.options.home), models } });
		} catch {
			this.reply(conversation, id, { error: { code: "fleet_error", message: "The controller's model list was not JSON." } });
		}
	}

	private async chat(conversation: string, id: number, body: Record<string, unknown>): Promise<void> {
		this.close(conversation);
		const abort = new AbortController();
		this.chats.set(conversation, abort);
		const answer = await this.call("/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({ ...body, stream: true }),
			signal: abort.signal,
		});
		if (!(answer instanceof Response) || !answer.body) {
			if (this.chats.get(conversation) === abort) this.chats.delete(conversation);
			return this.reply(conversation, id, { error: answer instanceof Response ? { code: "fleet_error", message: "No reply body." } : answer });
		}
		this.reply(conversation, id, { result: { started: true } });
		const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (!data || data === "[DONE]") continue;
					const chunk = parse(data);
					if (chunk !== undefined) this.event(conversation, { type: "fleet_chunk", chunk });
					else {
						this.event(conversation, { type: "fleet_error", message: "The controller sent a chunk that is not JSON." });
						abort.abort();
						return;
					}
				}
			}
			this.event(conversation, { type: "fleet_end" });
		} catch (err) {
			if (!abort.signal.aborted) this.event(conversation, { type: "fleet_error", message: `The reply stopped: ${(err as Error).message}` });
		} finally {
			if (this.chats.get(conversation) === abort) this.chats.delete(conversation);
		}
	}

	close(conversation: string): void {
		this.chats.get(conversation)?.abort();
		this.chats.delete(conversation);
	}

	closeAll(): void {
		for (const name of [...this.chats.keys()]) this.close(name);
		this.seen.clear();
	}
}
