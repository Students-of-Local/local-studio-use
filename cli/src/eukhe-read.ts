/**
 * A saved Local Studio session's messages, read from its files and never changed: opening it through the daemon would
 * give it a worker the app then shares, or is kept out of. Two forms (eukhe-core durable/discovery.rs): a `<id>/` folder
 * whose `main.jsonl` is a log of commits (format 1; another format is refused), and a `<id>.jsonl` file not opened yet.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

/** A session bigger than this is not read. */
const MAX_BYTES = 128 * 1024 * 1024;
/** The main conversation; the others are its subagents'. */
const ROOT = 1;
const KINDS: ReadonlySet<unknown> = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every message in order. A notice of the app's own is a row of role "custom"; a half-written last line is left out. */
export function readSession(path: string): Row[] {
	const folder = lstatSync(path).isDirectory();
	const file = folder ? join(path, "main.jsonl") : path;
	const st = lstatSync(file);
	if (!st.isFile() || st.size > MAX_BYTES) throw new Error(`${file} is not a session file Local Studio reads`);
	const out: Row[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(row)) continue;
		if (!folder) {
			if (row.type === "message" && isRecord(row.message)) out.push(row.message);
			continue;
		}
		if (row.format !== 1) throw new Error(`${file} has format ${String(row.format)}, which this version can't read`);
		for (const write of Array.isArray(row.writes) ? row.writes : []) {
			const entry = isRecord(write) && write.type === "entry" && isRecord(write.value) ? write.value : undefined;
			if (!entry || entry.conversationId !== ROOT) continue;
			if (KINDS.has(entry.kind)) out.push(...(Array.isArray(entry.model) ? entry.model.filter(isRecord) : []));
			else if (entry.kind === "eukhe.custom" && isRecord(entry.data) && !String(entry.data.customType).startsWith("eukhe.")) {
				// Its text is the user message the model saw, or in the data of one the model never saw.
				const said = Array.isArray(entry.model) && isRecord(entry.model[0]) ? { content: entry.model[0].content, timestamp: entry.model[0].timestamp } : {};
				out.push({ role: "custom", timestamp: out.at(-1)?.timestamp ?? 0, ...entry.data, ...said });
			}
		}
	}
	return out;
}
