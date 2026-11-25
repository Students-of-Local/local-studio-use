/**
 * The extension's ID has outlived more than one name, and its stored data was named after it: the IndexedDB
 * database and the dotted keys in chrome.storage.local. What a build under an earlier name left is found here by
 * shape (another database with this app's stores, named `<word>-storage`) and moved once, so a
 * person's threads, provider keys and settings come along. The earlier database goes only after every record in
 * it is in this one; a move that stops halfway goes on at the next open.
 */

import type { StorageBackend } from "@mariozechner/pi-web-ui";
import { COPILOT_API } from "../subscriptions/constants.js";
import { DB_NAME } from "./db-name.js";

const PREFIX = "local-studio.";

/** What a person chose, or was already shown. Update progress, pending requests and the like are not worth keeping. */
const KEPT = [
	"appearance",
	"mode",
	"dictation",
	"defaultSkillsSeeded",
	"chatgptPlanWelcomeShown",
	"whatsNewDismissed",
	"browserId",
];

/** One earlier database, read only. */
export interface EarlierStores {
	keys(store: string): Promise<string[]>;
	get(store: string, key: string): Promise<unknown>;
}

/** Which of `names` a build under an earlier name made, or undefined. */
export function earlierName(names: readonly string[]): string | undefined {
	return names.find((name) => name !== DB_NAME && /^[a-z]+-storage$/.test(name));
}

/** A thread that last ran on a Copilot model names the API as that build did. */
function currentApi(value: unknown): unknown {
	const model = (value as { model?: { api?: unknown } } | null)?.model;
	if (typeof model?.api !== "string" || !model.api.endsWith("-copilot-sdk") || model.api === COPILOT_API) return value;
	return { ...(value as object), model: { ...model, api: COPILOT_API } };
}

/** Copy every record `to` doesn't hold yet. True once all of them are there. */
export async function moveRecords(
	from: EarlierStores,
	to: Pick<StorageBackend, "has" | "set">,
	stores: readonly string[],
): Promise<boolean> {
	let whole = true;
	for (const store of stores) {
		for (const key of await from.keys(store)) {
			if (await to.has(store, key)) continue;
			await to.set(store, key, currentApi(await from.get(store, key)));
			whole = (await to.has(store, key)) && whole;
		}
	}
	return whole;
}

/** The chrome.storage.local values to write: `<word>.<key>` under this app's prefix, where it has none. */
export function movedSettings(all: Record<string, unknown>, word: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of KEPT) {
		if (all[PREFIX + key] === undefined && all[`${word}.${key}`] !== undefined)
			out[PREFIX + key] = all[`${word}.${key}`];
	}
	return out;
}

const done = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

async function move(to: Pick<StorageBackend, "has" | "set">, stores: readonly string[]): Promise<void> {
	const name = earlierName((await indexedDB.databases()).map((db) => db.name ?? ""));
	if (!name) return;
	const db = await done(indexedDB.open(name));
	let whole = false;
	try {
		// An older build may lack a newer store; none lacks these two.
		if (!["sessions", "settings"].every((store) => db.objectStoreNames.contains(store))) return;
		const store = (of: string) => db.transaction(of, "readonly").objectStore(of);
		const settings = movedSettings(await chrome.storage.local.get(null), name.slice(0, -"-storage".length));
		if (Object.keys(settings).length > 0) await chrome.storage.local.set(settings);
		whole = await moveRecords(
			{
				keys: async (of) => (await done(store(of).getAllKeys())).map(String),
				get: (of, key) => done(store(of).get(key)),
			},
			to,
			stores.filter((of) => db.objectStoreNames.contains(of)),
		);
	} finally {
		db.close();
	}
	if (whole) indexedDB.deleteDatabase(name);
}

/** Move what an earlier name left, one panel at a time. A failure leaves both databases for the next open. */
export async function adoptEarlierStorage(
	to: Pick<StorageBackend, "has" | "set">,
	stores: readonly string[],
): Promise<void> {
	try {
		await navigator.locks.request("local-studio-adopt", () => move(to, stores));
	} catch (err) {
		console.warn("Data an earlier version of the extension saved couldn't be moved:", err);
	}
}
