/**
 * Site changes outside the browser that made them: the document Export writes and Import reads, and the copy the native
 * host keeps at ~/.local-studio/browser/sites.json (cli/src/sites.ts). Whatever comes back in is checked again, entry by
 * entry, and a script always comes back off.
 */

import {
	added,
	EDIT_KINDS,
	type EditKind,
	guardedUnder,
	MAX_EDITS,
	type SiteEdit,
	type SiteEditsState,
} from "./store.js";

export interface SitesDocument {
	localStudioSites: 1;
	adBlock: boolean;
	edits: SiteEdit[];
}

/** The document for every site, or for one. */
export function sitesDocument(state: SiteEditsState, host?: string): SitesDocument {
	return {
		localStudioSites: 1,
		adBlock: !host && state.adBlock,
		edits: host ? state.edits.filter((e) => e.host === host) : state.edits,
	};
}

/** Who added an edit, as a document says it: "you" or "agent:<name>", and nothing else. */
const addedByOf = (v: unknown): string => (typeof v === "string" && /^agent:[^\r\n]{1,60}$/.test(v) ? v : "you");

/**
 * The state with a document's edits added: each through the same checks as a new one, a script off, an entry on a guarded
 * or shared site left out. Undefined when `raw` isn't such a document.
 */
export function withDocument(
	state: SiteEditsState,
	raw: unknown,
	guarded: readonly string[],
	newId: () => string,
	now: number,
): { state: SiteEditsState; added: number; leftOut: number } | undefined {
	const doc = raw as Partial<SitesDocument> | null;
	if (!doc || typeof doc !== "object" || doc.localStudioSites !== 1 || !Array.isArray(doc.edits)) return undefined;
	let next = state;
	let count = 0;
	let leftOut = Math.max(0, doc.edits.length - MAX_EDITS);
	for (const entry of doc.edits.slice(0, MAX_EDITS) as unknown[]) {
		const e = (entry ?? {}) as Partial<Record<keyof SiteEdit, unknown>>;
		try {
			const id = newId();
			const result = added(
				next,
				{
					host: String(e.host ?? ""),
					kind: (EDIT_KINDS as readonly unknown[]).includes(e.kind) ? (e.kind as EditKind) : ("" as EditKind),
					value: String(e.value ?? ""),
					note: typeof e.note === "string" ? e.note : "",
					actor: "agent",
					who: "",
				},
				id,
				now,
			);
			if (guardedUnder(result.edit.host, guarded)) throw new Error("guarded");
			// The same edit is already here: nothing to add, and nothing wrong with it.
			if (result.edit.id !== id) continue;
			const on = result.edit.kind !== "script" && e.on !== false;
			next = {
				...result.state,
				edits: result.state.edits.map((x) => (x.id === id ? { ...x, on, addedBy: addedByOf(e.addedBy) } : x)),
			};
			count++;
		} catch {
			leftOut++;
		}
	}
	return { state: next, added: count, leftOut };
}
