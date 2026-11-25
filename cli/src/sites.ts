/**
 * The site changes Local Studio keeps on this computer: the native host writes what each browser sends
 * (src/site-edits/keeper.ts) to ~/.local-studio/browser/sites.json, and a browser that never had a change of its own takes
 * the newest list from there. `local-studio-browser sites` reads it, or the open browser; no command turns a change on.
 *
 * { version: 1, browsers: { <browserId>: { name?, savedAt, adBlock, edits: [...] } } }
 */

import { join } from "node:path";
import { EDIT_KINDS, MAX_EDITS, MAX_NOTE, MAX_SCRIPT, type SiteEdit } from "../../src/site-edits/common.ts";
import { BridgeClient, BridgeRpcError } from "./client.ts";
import { configDir, readJsonFile, withFileLock, writeJsonPrivate } from "./files.ts";
import { COMMAND_NAME } from "./self.ts";
import { banner, c, sym } from "./ui.ts";

/** Browsers kept; the one saved longest ago goes first. */
const MAX_BROWSERS = 8;

interface SavedBrowser {
	name?: string;
	savedAt: number;
	adBlock: boolean;
	edits: SiteEdit[];
}

interface SitesFile {
	version: 1;
	browsers: Record<string, SavedBrowser>;
}

export const sitesFile = (): string => join(configDir(), "sites.json");

/** The fields of an edit, each checked; anything else the extension sent is dropped. */
function cleanEdit(raw: unknown): SiteEdit | undefined {
	const e = (raw ?? {}) as Partial<SiteEdit>;
	const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
	if (!text(e.id, 64) || !text(e.host, 253) || !text(e.value, MAX_SCRIPT) || !text(e.note, MAX_NOTE) || !text(e.addedBy, 80)) return undefined;
	if (!(EDIT_KINDS as readonly unknown[]).includes(e.kind) || typeof e.on !== "boolean" || typeof e.createdAt !== "number") return undefined;
	return { id: e.id, host: e.host, kind: e.kind as SiteEdit["kind"], value: e.value, note: e.note, addedBy: e.addedBy, on: e.on, createdAt: e.createdAt };
}

const cleanEdits = (raw: unknown): SiteEdit[] => (Array.isArray(raw) ? raw.slice(0, MAX_EDITS).flatMap((e) => cleanEdit(e) ?? []) : []);

/** What the file holds; a file that is missing or isn't one holds nothing. */
function readSites(): SitesFile {
	const browsers: Record<string, SavedBrowser> = Object.create(null) as Record<string, SavedBrowser>;
	try {
		const raw = readJsonFile<Partial<SitesFile> | null>(sitesFile(), null);
		for (const [id, b] of Object.entries(raw?.version === 1 && raw.browsers ? raw.browsers : {}))
			if (/^[A-Za-z0-9-]{1,64}$/.test(id) && b && typeof b.savedAt === "number")
				browsers[id] = { ...(typeof b.name === "string" ? { name: b.name.slice(0, 40) } : {}), savedAt: b.savedAt, adBlock: b.adBlock === true, edits: cleanEdits(b.edits) };
	} catch {
		/* not JSON: the next change writes a whole new file */
	}
	return { version: 1, browsers };
}

/** Keep a browser's list: the extension's `sites` message. */
export function saveSites(message: { edits?: unknown; adBlock?: unknown }, browserId: string | undefined, browserName: string | undefined, now = Date.now()): void {
	const id = browserId && /^[A-Za-z0-9-]{1,64}$/.test(browserId) ? browserId : "default";
	withFileLock(sitesFile(), () => {
		const { browsers } = readSites();
		browsers[id] = { ...(browserName ? { name: browserName.slice(0, 40) } : {}), savedAt: now, adBlock: message.adBlock === true, edits: cleanEdits(message.edits) };
		const newest = Object.entries(browsers).sort((a, b) => b[1].savedAt - a[1].savedAt);
		writeJsonPrivate(sitesFile(), { version: 1, browsers: Object.fromEntries(newest.slice(0, MAX_BROWSERS)) } satisfies SitesFile);
	});
}

/** The list a new browser starts from: the newest one with a change in it. */
export function savedSites(): (SavedBrowser & { localStudioSites: 1 }) | undefined {
	const newest = Object.values(readSites().browsers)
		.filter((b) => b.edits.length > 0)
		.sort((a, b) => b.savedAt - a.savedAt)[0];
	return newest ? { localStudioSites: 1, ...newest } : undefined;
}

export const SITES_USAGE = `Usage: ${COMMAND_NAME} sites [--json] | off <id> | remove <id>`;

export class SitesUsageError extends Error {}

/** A change in a few words, for a list. */
function describe(e: { kind: string; value?: string; note?: string; filter?: { words?: string[]; handles?: string[] } }): string {
	if (e.note) return e.note;
	const value = e.filter ? [...(e.filter.words ?? []), ...(e.filter.handles ?? [])].join(", ") : (e.value ?? "");
	return value.replace(/\s+/g, " ").slice(0, 60);
}

/** `local-studio-browser sites ...`; returns the exit code. */
export async function runSites(args: string[], opts: { json: boolean }): Promise<number> {
	const [sub = "list", id] = args;
	if (!["list", "off", "remove"].includes(sub)) throw new SitesUsageError(`Unknown subcommand "${sub}". ${SITES_USAGE}`);
	if ((sub === "list") !== (id === undefined)) throw new SitesUsageError(SITES_USAGE);
	const client = new BridgeClient({ name: "sites" });
	try {
		await client.connect().catch(() => undefined);
		const live = client.connected && client.extensionConnected;
		if (sub !== "list") {
			if (!live) throw new Error(`No browser is connected, so nothing was changed. Open it and run ${COMMAND_NAME} sites ${sub} ${id} again.`);
			await client.call(sub === "off" ? "edits.off" : "edits.remove", { id }).catch((err: unknown) => {
				throw err instanceof BridgeRpcError ? new Error(err.rpc.message) : err;
			});
			console.log(opts.json ? JSON.stringify({ [sub === "off" ? "off" : "removed"]: id }) : `${sym.ok} ${sub === "off" ? "Off" : "Removed"}: ${id}`);
			return 0;
		}
		const from = live ? ((await client.call("edits.list", {})) as { adBlock: boolean; edits: SiteEdit[] }) : (savedSites() ?? { adBlock: false, edits: [] });
		const { adBlock, edits } = from;
		if (opts.json) {
			console.log(JSON.stringify({ saved: !live, adBlock, edits }, null, 2));
			return 0;
		}
		console.log(banner("sites"));
		if (!edits.length) console.log("No site changes yet.");
		for (const host of [...new Set(edits.map((e) => e.host))].sort()) {
			console.log(host);
			for (const e of edits.filter((x) => x.host === host))
				console.log(`  ${e.on ? sym.ok : c.dim("-")} ${e.id}  ${e.kind.padEnd(6)} ${describe(e)}${e.on ? "" : c.dim(e.kind === "script" ? "  (off: turn it on in the side panel)" : "  (off)")}`);
		}
		if (!live) console.log(c.dim(`\nSaved copy, ${sitesFile()}. Open the browser to change one.`));
		return 0;
	} finally {
		client.close();
	}
}
