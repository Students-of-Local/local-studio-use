import assert from "node:assert/strict";
import { test } from "node:test";
import { earlierName, movedSettings, moveRecords } from "../src/storage/adopt.ts";

const stores = (data) => ({
	keys: async (store) => Object.keys(data[store] ?? {}),
	get: async (store, key) => data[store][key],
	has: async (store, key) => Object.hasOwn(data[store] ?? {}, key),
	set: async (store, key, value) => {
		data[store] ??= {};
		data[store][key] = value;
	},
});

test("an earlier name's database is known by its shape, never this one", () => {
	assert.equal(earlierName(["local-studio-storage", "oldname-storage"]), "oldname-storage");
	assert.equal(earlierName(["local-studio-storage", "cache", "some-thing-storage"]), undefined);
	assert.equal(earlierName([]), undefined);
});

test("every record is copied once, and what this build already holds is kept", async () => {
	const from = { sessions: { a: { id: "a" }, b: { id: "b" } }, settings: { theme: "old", tone: "old" } };
	const to = { settings: { theme: "new" } };
	assert.equal(await moveRecords(stores(from), stores(to), ["sessions", "settings"]), true);
	assert.deepEqual(to, { sessions: { a: { id: "a" }, b: { id: "b" } }, settings: { theme: "new", tone: "old" } });
});

test("a record that isn't there after the write keeps the earlier database", async () => {
	const to = { ...stores({}), set: async () => {} };
	assert.equal(await moveRecords(stores({ sessions: { a: { id: "a" } } }), to, ["sessions"]), false);
});

test("a thread on a Copilot model gets this build's API name", async () => {
	const to = {};
	const model = { id: "m", api: "oldname-copilot-sdk" };
	await moveRecords(stores({ sessions: { a: { id: "a", model } } }), stores(to), ["sessions"]);
	assert.equal(to.sessions.a.model.api, "local-studio-copilot-sdk");
	assert.equal(to.sessions.a.model.id, "m");
});

test("what a person chose comes along, an update's progress doesn't, and a newer choice wins", () => {
	const all = {
		"oldname.appearance": { preset: "rose" },
		"oldname.mode": "light",
		"local-studio.mode": "dark",
		"oldname.updateProgress": {},
		"other.dictation": {},
	};
	assert.deepEqual(movedSettings(all, "oldname"), { "local-studio.appearance": { preset: "rose" } });
});
