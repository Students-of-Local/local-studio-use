/**
 * Synthetic (synthetic.new): an OpenAI-compatible host of open models. pi-ai has no table for it, so its standing aliases
 * are registered here; a saved key lists the rest from its public model list (discovery.ts).
 */

import type { Api, Model } from "@mariozechner/pi-ai";

export const SYNTHETIC = "synthetic";
export const SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";
/** An alias Synthetic moves to a newer model as it changes its own, so the default never names a retired one. */
export const SYNTHETIC_DEFAULT_MODEL = "syn:large:text";

/** The plain chat completions form: no stored replies, and the system prompt as `system`. */
export const SYNTHETIC_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as const;

/** What to call an alias: `syn:large:text` is "Large". */
const ALIAS_NAMES: Record<string, string> = {
	"syn:large:text": "Large",
	"syn:small:text": "Small",
	"syn:large:vision": "Large vision",
	"syn:small:vision": "Small vision",
};

/** An alias's own name, with the model it stands for today. */
export function syntheticName(id: string, displayName?: string, aliasOf?: string | null): string {
	const alias = ALIAS_NAMES[id];
	if (alias) return aliasOf ? `${alias} (${aliasOf})` : alias;
	return displayName && displayName !== id ? displayName : id.replace(/^hf:[^/]*\//, "");
}

/** Until a key lists them. Their limits are the smallest the alias has had. */
export const SYNTHETIC_SEED: Model<Api>[] = Object.keys(ALIAS_NAMES).map(
	(id) =>
		({
			id,
			name: syntheticName(id),
			api: "openai-completions",
			provider: SYNTHETIC,
			baseUrl: SYNTHETIC_BASE_URL,
			reasoning: true,
			input: id.endsWith(":vision") ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 196608,
			maxTokens: 65536,
			compat: SYNTHETIC_COMPAT,
		}) as Model<Api>,
);
