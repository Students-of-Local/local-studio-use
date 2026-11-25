// What the Models page lists, in what order, and what its search finds (src/models/pick.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { findModels, modelFacts, modelGroups } from "../src/models/pick.ts";

const model = (provider, id, name, more = {}) => ({ provider, id, name, reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, ...more });
const names = (list) => list.map((m) => m.id);

test("newest first in a provider; a size or a date is no version", () => {
	const [group] = modelGroups([model("x", "a", "Opus 3"), model("x", "b", "Opus 5.5"), model("x", "c", "Llama 3.3 70B"), model("x", "d", "Opus 4 20250514")], null);
	assert.deepEqual(names(group.models), ["b", "d", "c", "a"]);
});

test("the provider in use leads, then Local Studio, then by name; the model in use leads its group", () => {
	const current = model("openai", "gpt-4", "GPT-4");
	const groups = modelGroups([model("anthropic", "o", "Opus 5.5"), model("local-studio", "q", "Qwen 3"), model("openai", "gpt-5", "GPT-5"), current], current);
	assert.deepEqual(groups.map((g) => g.provider), ["openai", "local-studio", "anthropic"]);
	assert.deepEqual(names(groups[0].models), ["gpt-4", "gpt-5"]);
});

test("dated copies of one model show once: the newest, or the one in use", () => {
	const old = model("x", "opus-20250101", "Opus 4");
	const list = [old, model("x", "opus-20250601", "Opus 4"), model("x", "opus-latest", "Opus 4 (latest)")];
	assert.deepEqual(names(modelGroups(list, null)[0].models), ["opus-latest"]);
	assert.deepEqual(names(modelGroups(list, old)[0].models), ["opus-20250101"]);
});

test("a search needs every word, forgives a skipped letter, and knows what can read images or think", () => {
	const list = [model("anthropic", "opus", "Claude Opus 5.5"), model("openai", "mini", "GPT-5 mini", { input: ["text"], reasoning: false })];
	assert.deepEqual(names(findModels(list, "opus anthropic")), ["opus"]);
	assert.deepEqual(names(findModels(list, "cld ops")), ["opus"]);
	assert.deepEqual(names(findModels(list, "images")), ["opus"]);
	assert.deepEqual(names(findModels(list, "thinking")), ["opus"]);
	assert.deepEqual(names(findModels(list, "opus zzzz")), []);
});

test("facts are short: price, context, and only what a model can't do", () => {
	assert.equal(modelFacts(model("x", "a", "A")), "$3 in · $15 out · 200K context");
	assert.equal(modelFacts(model("x", "a", "A", { cost: { input: 0, output: 0 }, contextWindow: 1048576, input: ["text"] })), "Free · 1M context · no images");
});
