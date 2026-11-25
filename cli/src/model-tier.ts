/**
 * How capable the model behind an agent is, for the "Match the model" site access mode (docs/decisions.md, D60).
 *
 * "frontier" means about 75 or more on Vals.ai SWE-bench Verified: Opus 4.5 76.4, Sonnet 4.6 77.4, GPT-5.2 75.8,
 * Gemini 3 Pro 76.4, Gemini 3 Flash 75.0, Grok 4.5 86.6, DeepSeek V4 Pro 96.4, Kimi K2.6 76.2, GLM 5.3 95.4,
 * MiniMax M3 75.0, Qwen 3.8 Max 85.6. Below it: Haiku 4.5 66.6, Sonnet 4.5 70.0, GPT-5.1 69.8, GPT-5 mini 60.8,
 * Grok 4 57.8, DeepSeek V3.2 67.6, Kimi K2.5 70.0, GLM 5 71.4. A model that is small by parameter count is small even
 * when its score is high. A name this cannot place is "unknown", which asks like a small one.
 *
 * Local Studio ships the same rules in Rust; test/model-tier.test.mjs holds the cases both give.
 */
import type { ModelTier } from "../../src/bridge/protocol.ts";

export type { ModelTier };

/** A piece equal to one of these marks a small or open-weight line. */
const SMALL_WORDS: ReadonlySet<string> = new Set([
	"haiku",
	"mini",
	"nano",
	"lite",
	"oss",
	"small",
	"tiny",
	"gemma",
	"phi",
	"smol",
	"smollm",
	"tinyllama",
	"llama",
	"codellama",
	"mistral",
	"ministral",
	"mixtral",
	"devstral",
	"codestral",
	"granite",
]);

/** A family (its pieces in order) and the first version that is frontier; `any` means every version is. */
const FAMILIES: ReadonlyArray<{ pieces: readonly string[]; min: readonly [number, number] | "any"; bare: boolean }> = [
	{ pieces: ["opus"], min: [4, 5], bare: true },
	{ pieces: ["sonnet"], min: [4, 6], bare: true },
	{ pieces: ["fable"], min: "any", bare: true },
	{ pieces: ["gpt"], min: [5, 2], bare: false },
	{ pieces: ["gemini"], min: [3, 0], bare: false },
	{ pieces: ["grok"], min: [4, 5], bare: false },
	{ pieces: ["deepseek", "v"], min: [4, 0], bare: false },
	{ pieces: ["kimi", "k"], min: [2, 6], bare: false },
	{ pieces: ["glm"], min: [5, 3], bare: false },
	{ pieces: ["minimax", "m"], min: [3, 0], bare: false },
	{ pieces: ["qwen"], min: [3, 8], bare: false },
];

const isVersionPiece = (p: string | undefined): p is string => p !== undefined && /^\d{1,3}$/.test(p);

/** The model's name as the rules read it: lowercase, no "[...]" suffix, no provider path. */
function normalize(model: string): string {
	const lower = model.toLowerCase();
	const cut = lower.indexOf("[");
	const head = cut >= 0 ? lower.slice(0, cut) : lower;
	return head.slice(head.lastIndexOf("/") + 1);
}

/** "qwen3.8-27b" -> tokens qwen3, 8, 27b and pieces qwen, 3, 8, 27, b. */
function split(name: string): { tokens: string[]; pieces: string[] } {
	const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
	const pieces = tokens.flatMap((t) => t.match(/[a-z]+|\d+/g) ?? []);
	return { tokens, pieces };
}

/** Parameter count in billions from a token like "27b" or "8x7b"; undefined for anything else, "a3b" included. */
function paramsOf(token: string): number | undefined {
	const plain = /^(\d+)b$/.exec(token);
	if (plain) return Number(plain[1]);
	const moe = /^(\d+)x(\d+)b$/.exec(token);
	if (moe) return Number(moe[1]) * Number(moe[2]);
	return undefined;
}

function atLeast(version: readonly number[], min: readonly [number, number]): boolean {
	const major = version[0] ?? 0;
	const minor = version[1] ?? 0;
	return major !== min[0] ? major > min[0] : minor >= min[1];
}

/** Classify a model by its name. Rules apply in order: small words, a size under 100B, then family and version. */
export function modelTier(model: string): ModelTier {
	const { tokens, pieces } = split(normalize(model));
	if (pieces.some((p) => SMALL_WORDS.has(p))) return "small";
	if (tokens.some((t) => /^\d/.test(t) && (paramsOf(t) ?? Number.POSITIVE_INFINITY) < 100)) return "small";
	for (const family of FAMILIES) {
		const at = pieces.findIndex((_, i) => family.pieces.every((f, j) => pieces[i + j] === f));
		if (at < 0) continue;
		const version: number[] = [];
		for (let i = at + family.pieces.length; isVersionPiece(pieces[i]); i++) version.push(Number(pieces[i]));
		if (version.length === 0) {
			// "claude-3-7-sonnet": the version comes before the family.
			let start = at;
			while (isVersionPiece(pieces[start - 1])) start--;
			for (let i = start; i < at; i++) version.push(Number(pieces[i]));
		}
		if (version.length === 0) return family.bare ? "frontier" : "unknown";
		if (family.min === "any") return "frontier";
		return atLeast(version, family.min) ? "frontier" : "small";
	}
	return "unknown";
}

/** MCP clients that run a frontier model unless told otherwise: Claude Code and Codex, by their initialize name. */
const FRONTIER_CLIENTS: ReadonlySet<string> = new Set(["claude-code", "claude-ai", "claude", "codex", "codex-mcp-client", "codex_cli"]);

/** The model a `--model X`, `--model=X` or `-m X` flag in a command line names, if any. */
export function modelFlag(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--model=")) return arg.slice("--model=".length) || undefined;
		if ((arg === "--model" || arg === "-m") && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
	}
	return undefined;
}

/** What started this server: the model a `--model` flag names, and whether `--oss` runs a local model. */
export type Launch = { model?: string; local: boolean };

/** One process as `ps` or Windows reports it: its parent and its command line. */
export type ProcessInfo = { ppid: number; args: string[] };

/** The launch flags of the agent that started this server, from it or up to two of its own parents. */
export function launchOf(start: number, read: (pid: number) => ProcessInfo | undefined): Launch {
	let pid = start;
	let local = false;
	for (let depth = 0; depth < 3 && pid > 1; depth++) {
		const info = read(pid);
		if (!info) break;
		if (info.args.includes("--oss")) local = true;
		const model = modelFlag(info.args);
		if (model) return { model, local };
		pid = info.ppid;
	}
	return { local };
}

/**
 * The model a client's own config sets. Claude Code: the first settings.json text (highest precedence first) with a
 * `model`. Codex: config.toml's top-level `model`, and `local` when `oss` is on or `model_provider` isn't OpenAI.
 */
export function configuredModel(client: "claude" | "codex", files: readonly (string | undefined)[]): Launch {
	if (client === "claude") {
		for (const text of files) {
			if (!text) continue;
			try {
				const model = (JSON.parse(text) as { model?: unknown }).model;
				if (typeof model === "string" && model.trim()) return { model: model.trim(), local: false };
			} catch {}
		}
		return { local: false };
	}
	const text = files.find(Boolean);
	if (!text) return { local: false };
	const top: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) break;
		const match = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
		if (match) top[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	const provider = top.model_provider?.toLowerCase();
	const local = top.oss === "true" || (provider !== undefined && provider !== "openai");
	return top.model ? { model: top.model, local } : { local };
}

/** True when a base URL points somewhere other than the vendor's own host, such as a local model or a proxy. */
function offVendor(baseUrl: string | undefined, vendor: string): boolean {
	if (!baseUrl?.trim()) return false;
	try {
		const host = new URL(baseUrl.trim()).hostname.toLowerCase();
		return host !== vendor && !host.endsWith(`.${vendor}`);
	} catch {
		return true;
	}
}

/**
 * The tier an MCP session reports in its bridge hello. A model named in LOCAL_STUDIO_BROWSER_MODEL decides it.
 * Without one, a session on the small tool profile (a local model) is small. Claude Code and Codex are rated by the
 * model they run (`clientModel`: launch flag, env or their own config), and are frontier when none is set, because
 * both default to a frontier model. A session served off the vendor's endpoint (a base URL that isn't Anthropic's or
 * OpenAI's, or Codex `--oss` or another provider) is never frontier: its model name proves nothing. Every other client
 * is unknown.
 */
export function sessionTier(o: { model?: string; clientName?: string; small?: boolean; clientModel?: string; baseUrl?: string; local?: boolean }): {
	tier: ModelTier;
	model?: string;
} {
	const model = o.model?.trim();
	if (model) return { tier: modelTier(model), model: model.slice(0, 128) };
	if (o.small) return { tier: "small" };
	const client = o.clientName?.trim().toLowerCase();
	if (!client || !FRONTIER_CLIENTS.has(client)) return { tier: "unknown" };
	const off = o.local === true || offVendor(o.baseUrl, client.startsWith("claude") ? "anthropic.com" : "openai.com");
	const clientModel = o.clientModel?.trim();
	const tier = clientModel ? modelTier(clientModel) : "frontier";
	const rated: ModelTier = off && tier === "frontier" ? "unknown" : tier;
	return clientModel ? { tier: rated, model: clientModel.slice(0, 128) } : { tier: rated };
}
