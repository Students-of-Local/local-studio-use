// Settings > Privacy, "Look up model details on models.dev": switched off, refreshing a provider's model list
// never asks models.dev, and the list still registers. PRIVACY.md names this switch as the way to turn the lookup off.
import assert from "node:assert/strict";
import { test } from "node:test";

const { refreshProviderModels } = await import("../src/models/registry.ts");

// The stored key, written out: renaming it would silently switch the lookup back on for everyone who turned it off.
const KEY = "privacy.modelsDev";

function fakeStorage(setting) {
	const lists = new Map();
	let metadata = null;
	return {
		settings: { get: async (key) => (key === KEY ? setting : undefined), set: async () => {} },
		providerKeys: { get: async (p) => (p === "openai" ? "test-key" : null), list: async () => ["openai"] },
		discoveredModels: {
			get: async (p) => lists.get(p) ?? null,
			set: async (entry) => void lists.set(entry.provider, entry),
			delete: async (p) => void lists.delete(p),
			getMetadata: async () => metadata,
			setMetadata: async (data) => {
				metadata = { fetchedAt: Date.now(), data };
			},
		},
		lists,
	};
}

async function refreshWith(setting) {
	const hosts = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		hosts.push(url.host);
		const body = url.host === "models.dev" ? { openai: { models: { "gpt-5": { name: "GPT-5" } } } } : { data: [{ id: "gpt-5" }] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	const storage = fakeStorage(setting);
	try {
		await refreshProviderModels(storage, "openai");
	} finally {
		globalThis.fetch = realFetch;
	}
	return { hosts, models: storage.lists.get("openai")?.models ?? [] };
}

// Off runs first: an on run fills the module's in-memory copy, after which no run fetches at all.
test("switched off, a model list refresh never asks models.dev", async () => {
	const { hosts, models } = await refreshWith(false);
	assert.deepEqual(hosts, ["api.openai.com"]);
	assert.deepEqual(
		models.map((m) => m.id),
		["gpt-5"],
	);
});

test("on by default, the refresh fills model details from models.dev", async () => {
	const { hosts, models } = await refreshWith(undefined);
	assert.deepEqual([...hosts].sort(), ["api.openai.com", "models.dev"]);
	assert.equal(models[0].name, "GPT-5");
});
