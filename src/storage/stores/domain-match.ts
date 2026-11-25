/** Past these a skill's patterns and a page's path are not read: the lookup runs on every page and must stay quick. */
const MAX_PATTERNS = 100;
const MAX_PATTERN = 256;
const MAX_PATH = 1024;
/** No host name is longer. */
const MAX_HOST = 253;

/** `*` and `?` in one path segment or host, in time that grows with the product of the lengths and no more. */
function segmentMatches(text: string, glob: string): boolean {
	// As in a shell, a wildcard at the start matches nothing in an empty or dotted segment.
	if (/^[*?]/.test(glob) && (!text || text[0] === ".")) return false;
	let t = 0;
	let g = 0;
	let star = -1;
	let from = 0;
	while (t < text.length) {
		if (glob[g] === "*") {
			star = g++;
			from = t;
		} else if (g < glob.length && (glob[g] === "?" || glob[g] === text[t])) {
			g++;
			t++;
		} else if (star >= 0) {
			g = star + 1;
			t = ++from;
		} else return false;
	}
	while (glob[g] === "*") g++;
	return g === glob.length;
}

/** A path against a path glob: `**` as a whole segment is any number of segments (at the end, one or more). */
function pathMatches(path: string, glob: string): boolean {
	// "/a/" is ["a", ""]: a trailing slash is a last, empty segment.
	const segments = path.split(/\/+/).slice(1);
	const globs = glob.split(/\/+/).slice(1);
	/** Which of the path's first n segments the globs so far match. */
	let reach = [true, ...segments.map(() => false)];
	for (const [i, part] of globs.entries()) {
		if (part === "**") {
			const last = i === globs.length - 1;
			let open = false;
			reach = reach.map((ok, n) => {
				if (n > 0 && segments[n - 1].startsWith(".")) open = false;
				const here = last ? open && n > 0 : open || ok;
				open ||= ok;
				return here;
			});
		} else reach = [false, ...segments.map((text, n) => reach[n] && segmentMatches(text, part))];
	}
	// "/a/" is also "/a".
	return reach[segments.length] || (segments.at(-1) === "" && globs.at(-1) !== "" && reach[segments.length - 1]);
}

/**
 * Does `url` match any of a site skill's domain patterns? A pattern is a host glob with an
 * optional path glob: `calendar.google.com`, `google.*\/search*`, `docs.google.com/spreadsheets/**`. In a
 * glob `*` is any run of characters but `/`, `?` is one and `**` is any number of path segments;
 * everything else is itself.
 * The host must match the whole host name (a leading `www.` is ignored on both sides), so
 * `calendar.google.com` never matches `mail.google.com`. Only http and https pages match.
 */
export function matchesDomainPatterns(url: string, patterns: readonly string[]): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const host = parsed.hostname.replace(/^www\./, "");
	if (host.length > MAX_HOST) return false;
	let path = parsed.pathname.toLowerCase();
	// A cut path is known by its first segments only, so just a pattern that takes any rest (`/a/**`) matches it.
	const cut = path.length > MAX_PATH;
	if (cut) path = path.slice(0, path.lastIndexOf("/", MAX_PATH));
	for (const pattern of patterns.slice(0, MAX_PATTERNS)) {
		const trimmed = pattern.trim().toLowerCase();
		if (!trimmed || trimmed.length > MAX_PATTERN) continue;
		const slash = trimmed.indexOf("/");
		const hostPattern = (slash < 0 ? trimmed : trimmed.slice(0, slash)).replace(/^www\./, "");
		const pathPattern = slash < 0 ? "" : trimmed.slice(slash);
		if (!hostPattern || !segmentMatches(host, hostPattern)) continue;
		if (!pathPattern || pathPattern === "/") return true;
		if ((!cut || pathPattern.endsWith("/**")) && pathMatches(path, pathPattern)) return true;
	}
	return false;
}

/** The host a URL belongs to for "once per site visit" (no `www.`), or undefined. */
export function siteOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "") || undefined;
	} catch {
		return undefined;
	}
}
