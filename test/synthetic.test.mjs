// Synthetic: what its public model list becomes. The rows below are the ones api.synthetic.new answered on 2026-11-25.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getModels } from "@mariozechner/pi-ai";

const { refreshProviderModels } = await import("../src/models/registry.ts");
const { SYNTHETIC_DEFAULT_MODEL } = await import("../src/models/synthetic.ts");
const { providerDisplayName } = await import("../src/models/display.ts");

const ROWS = [
	{ id: "syn:large:text", display_name: "syn:large:text", alias_of: "DeepSeek V4.1 Flash 10/17", input_modalities: ["text", "image"], context_length: 524288, max_output_length: 65536, pricing: { prompt: "$0.0000006", completion: "$0.0000012", input_cache_reads: "$0.00000003", input_cache_writes: "0" }, supported_features: ["tools", "reasoning"] },
	{ id: "hf:zai-org/GLM-5.3", display_name: "GLM 5.3", alias_of: null, input_modalities: ["text"], context_length: 524288, max_output_length: 65536, pricing: { prompt: "$0.0000014", completion: "oops" }, supported_features: ["tools"] },
	{ id: "hf:someone/Embedder", display_name: "Embedder", input_modalities: ["text"], supported_features: ["json_mode"] },
	{ id: "hf:org/Plain-Name", supported_features: ["tools"] },
];

function storage(key) {
	const lists = new Map();
	return {
		settings: { get: async () => false, set: async () => {} },
		providerKeys: { get: async (p) => (p === "synthetic" ? key : null), list: async () => ["synthetic"] },
		discoveredModels: {
			get: async (p) => lists.get(p) ?? null,
			set: async (e) => void lists.set(e.provider, e),
			delete: async (p) => void lists.delete(p),
			getMetadata: async () => null,
			setMetadata: async () => {},
		},
	};
}

async function list(key, answer) {
	const calls = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
		return answer();
	};
	try {
		await refreshProviderModels(storage(key), "synthetic");
	} finally {
		globalThis.fetch = real;
	}
	return calls;
}

test("before a key, the standing aliases are there and the default is one of them", () => {
	assert.equal(providerDisplayName("synthetic"), "Synthetic");
	const ids = getModels("synthetic").map((m) => m.id);
	assert.deepEqual(ids, ["syn:large:text", "syn:small:text", "syn:large:vision", "syn:small:vision"]);
	assert.ok(ids.includes(SYNTHETIC_DEFAULT_MODEL));
	for (const m of getModels("synthetic")) assert.equal(m.baseUrl, "https://api.synthetic.new/openai/v1");
});

test("the list becomes models: tools only, dollars a million, limits, images, and the key is not sent", async () => {
	const calls = await list("k", () => Response.json({ data: ROWS }));
	assert.deepEqual(calls, [{ url: "https://api.synthetic.new/openai/v1/models", auth: null }]);
	const models = new Map(getModels("synthetic").map((m) => [m.id, m]));
	assert.deepEqual([...models.keys()], ["hf:org/Plain-Name", "hf:zai-org/GLM-5.3", "syn:large:text"]);
	const large = models.get("syn:large:text");
	assert.equal(large.name, "Large (DeepSeek V4.1 Flash 10/17)");
	assert.deepEqual(large.input, ["text", "image"]);
	assert.equal(large.contextWindow, 524288);
	assert.equal(large.maxTokens, 65536);
	assert.equal(large.reasoning, true);
	assert.deepEqual(Object.values(large.cost).map((n) => Number(n.toFixed(4))), [0.6, 1.2, 0.03, 0]);
	assert.deepEqual(large.compat, { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" });
	assert.equal(models.get("hf:zai-org/GLM-5.3").cost.output, 0, "a price that isn't a number counts as none");
	assert.equal(models.get("hf:zai-org/GLM-5.3").reasoning, false);
	assert.equal(models.get("hf:org/Plain-Name").name, "Plain-Name");
});

test("a failed list keeps the last one; without a key the aliases come back", async () => {
	await list("k", () => new Response("no", { status: 503 }));
	assert.ok(getModels("synthetic").length > 0);
	await list(undefined, () => Response.json({ data: ROWS }));
	assert.deepEqual(getModels("synthetic").length, 4);
});
