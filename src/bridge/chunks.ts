/**
 * Frames from the native host larger than one native message. Chrome refuses a host to extension message over 1 MiB and
 * closes the port, so the host cuts such a frame's JSON bytes into HostChunk pieces and the extension joins them
 * (cli/src/host.ts toExtension, src/bridge/native.ts). Shared by both sides: plain functions, no Node or Chrome APIs.
 */

import type { HostChunk } from "./protocol.js";

/** Bytes of the frame per piece: 600 KiB is 800 KiB of base64, under MAX_FRAME_TO_EXTENSION with the frame around it. */
export const CHUNK_PIECE_BYTES = 600 * 1024;
/** The largest frame sent in pieces; a bigger one is still refused (64 MiB, the size Chrome takes the other way). */
export const MAX_CHUNKED_FRAME_BYTES = 64 * 1024 * 1024;
/** Frames being joined at once; a host interleaves none today, so more than this means pieces were lost. */
const MAX_OPEN = 4;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** The pieces of one frame whose UTF-8 JSON is `json`, in order. */
export function chunkFrame(json: Uint8Array, id: number, piece: number = CHUNK_PIECE_BYTES): HostChunk[] {
	const count = Math.max(1, Math.ceil(json.length / piece));
	const out: HostChunk[] = [];
	for (let index = 0; index < count; index++)
		out.push({ type: "chunk", id, index, count, data: toBase64(json.subarray(index * piece, (index + 1) * piece)) });
	return out;
}

/** Joins pieces back into frames. Pieces of one frame arrive in order (one native port is ordered). */
export class ChunkAssembler {
	private readonly open = new Map<number, { count: number; next: number; size: number; parts: Uint8Array[] }>();

	/**
	 * Take one piece. Returns `{ message }` when it completed a frame, `{ error }` when the piece is out of order, too big
	 * or the joined frame is not JSON (that frame is dropped), and `{}` while the frame is still incomplete.
	 */
	push(chunk: HostChunk): { message?: unknown; error?: string } {
		const { id, index, count, data } = chunk;
		if (
			!Number.isInteger(id) ||
			!Number.isInteger(index) ||
			!Number.isInteger(count) ||
			count < 1 ||
			typeof data !== "string"
		)
			return { error: "malformed piece" };
		let entry = this.open.get(id);
		if (!entry) {
			if (index !== 0) return { error: `piece ${index} of frame ${id} came before its first piece` };
			if (this.open.size >= MAX_OPEN) {
				const oldest = this.open.keys().next().value as number;
				this.open.delete(oldest);
			}
			entry = { count, next: 0, size: 0, parts: [] };
			this.open.set(id, entry);
		}
		if (index !== entry.next || count !== entry.count) {
			this.open.delete(id);
			return { error: `frame ${id}: expected piece ${entry.next} of ${entry.count}, got ${index} of ${count}` };
		}
		const bytes = fromBase64(data);
		entry.size += bytes.length;
		if (entry.size > MAX_CHUNKED_FRAME_BYTES) {
			this.open.delete(id);
			return { error: `frame ${id} is over ${MAX_CHUNKED_FRAME_BYTES} bytes` };
		}
		entry.parts.push(bytes);
		entry.next++;
		if (entry.next < entry.count) return {};
		this.open.delete(id);
		const joined = new Uint8Array(entry.size);
		let at = 0;
		for (const part of entry.parts) {
			joined.set(part, at);
			at += part.length;
		}
		try {
			return { message: JSON.parse(new TextDecoder().decode(joined)) };
		} catch (err) {
			return { error: `frame ${id} is not JSON: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/** Pieces of frames still waiting (for tests and the debug page). */
	get pending(): number {
		return this.open.size;
	}
}
