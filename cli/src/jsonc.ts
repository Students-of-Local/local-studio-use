/**
 * JSONC, as OpenCode reads it: JSON with line and block comments and trailing commas. Comments become spaces and
 * trailing commas become a space, so every offset in the result still points at the same text in the file.
 */

/** End offset (exclusive) of the string starting at `i`. */
export function stringEnd(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return j + 1;
}

export function skipSpace(text: string, i: number): number {
	while (/\s/.test(text[i] ?? "")) i++;
	return i;
}

/** Comments become spaces (newlines kept), so every offset still points at the same text. */
export function blankComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const end = stringEnd(text, i);
			out += text.slice(i, end);
			i = end;
		} else if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
			const close = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 2;
			const end = close <= 1 ? text.length : close;
			out += text.slice(i, end).replace(/[^\n]/g, " ");
			i = end;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/** A comma right before } or ] becomes a space, so JSON.parse reads JSONC's trailing commas. */
export function dropTrailingCommas(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const end = stringEnd(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		const next = ch === "," ? text[skipSpace(text, i + 1)] : undefined;
		out += next === "}" || next === "]" ? " " : ch;
		i++;
	}
	return out;
}

/** Parse JSONC text. Throws like JSON.parse when it isn't valid. */
export function parseJsonc(text: string): unknown {
	return JSON.parse(dropTrailingCommas(blankComments(text)));
}
