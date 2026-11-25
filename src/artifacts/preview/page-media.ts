/** Pictures and fonts of a document preview, apart from the slide drawing so a viewer loads that only for slides. */

import type { Deck } from "./pptx.js";

/** Blob URLs for the deck's images. Call `revoke` when the preview goes away. */
export function imageUrls(deck: Pick<Deck, "images">): { urls: Map<string, string>; revoke: () => void } {
	const urls = new Map<string, string>();
	for (const [path, img] of deck.images) {
		const copy = new Uint8Array(img.data.length);
		copy.set(img.data);
		urls.set(path, URL.createObjectURL(new Blob([copy.buffer], { type: img.mime })));
	}
	return {
		urls,
		revoke: () => {
			for (const u of urls.values()) URL.revokeObjectURL(u);
		},
	};
}

const SANS_FALLBACK = '"Helvetica Neue", Arial, sans-serif';
const FONT_FALLBACKS: Record<string, string> = {
	calibri: `Carlito, ${SANS_FALLBACK}`,
	"calibri light": `Carlito, ${SANS_FALLBACK}`,
	cambria: "Caladea, Georgia, serif",
	"times new roman": '"Times New Roman", Times, serif',
	georgia: "Georgia, serif",
	garamond: "Garamond, Georgia, serif",
	"courier new": '"Courier New", Courier, monospace',
	consolas: 'Consolas, Menlo, "Courier New", monospace',
	"lucida console": 'Menlo, "Courier New", monospace',
};

export function fontFamily(font: string | undefined): string {
	if (!font) return SANS_FALLBACK;
	const safe = font.replace(/["\\;{}<>]/g, "");
	const fallback = FONT_FALLBACKS[safe.toLowerCase()] ?? SANS_FALLBACK;
	return `"${safe}", ${fallback}`;
}
