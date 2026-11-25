let next = 0;

/**
 * The SVG with every id it defines given a suffix of its own, and every url(#id) and href="#id" to it changed to match.
 * An inline SVG's ids share the page with every other copy: a second copy of an icon with a gradient would paint from
 * the first one's gradient, and draw nothing when that copy is hidden or removed.
 */
export function uniqueSvgIds(svg: string): string {
	const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	if (ids.length === 0) return svg;
	const suffix = `-${++next}`;
	let out = svg;
	for (const id of ids) {
		const name = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out
			.replace(new RegExp(`(\\sid=")${name}"`, "g"), `$1${id}${suffix}"`)
			.replace(new RegExp(`url\\(#${name}\\)`, "g"), `url(#${id}${suffix})`)
			.replace(new RegExp(`(href=")#${name}"`, "g"), `$1#${id}${suffix}"`);
	}
	return out;
}
