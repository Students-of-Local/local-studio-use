/** The selector check that hide and style edits share, and the error every site-edit check throws. */

export const MAX_SELECTORS = 2000;

export class SiteEditError extends Error {}

/**
 * Selectors only. A brace, an at-rule or url() would let one edit add any CSS, and CSS can read what is
 * typed into a page (attribute selectors with background images) and send it out.
 */
export function checkSelectors(raw: string): string {
	const selectors = raw.trim();
	if (!selectors) throw new SiteEditError("Give at least one CSS selector to hide.");
	if (selectors.length > MAX_SELECTORS)
		throw new SiteEditError(`Selectors are limited to ${MAX_SELECTORS} characters.`);
	if (/[{};@\\]|url\s*\(|<\/?style/i.test(selectors))
		throw new SiteEditError("Only selectors: no braces, semicolons, @ rules, backslashes or url().");
	// An open comment, bracket, parenthesis or quote would run into the next edit's rule in the same sheet.
	if (/\/\*|\*\//.test(selectors)) throw new SiteEditError("No comments in selectors.");
	// A line break ends a CSS string early, so a quote that looks closed here wouldn't be in the sheet.
	if (/[\r\n\f]/.test(selectors)) throw new SiteEditError("Selectors go on one line.");
	if (!balanced(selectors)) throw new SiteEditError("Unbalanced brackets, parentheses or quotes in the selectors.");
	return selectors;
}

export function balanced(text: string): boolean {
	const stack: string[] = [];
	let quote = "";
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(" || ch === "[") stack.push(ch === "(" ? ")" : "]");
		else if ((ch === ")" || ch === "]") && stack.pop() !== ch) return false;
	}
	return !quote && stack.length === 0;
}
