/**
 * The check on a style edit: plain CSS rules that change how a site looks and nothing else. What an agent sends is read
 * strictly, rule by rule, and written out again in one form, so what reaches a page is only what this file understood.
 *
 * Nothing loads or is sent (functions by list: no url, src, image-set or attr), no text is added (no content, no strings
 * outside a font name), and nothing is laid over the page (no position, z-index, transform or negative offset): a style
 * can recolor, resize, space and hide what the site shows, never put up something of its own.
 */

import { DARK } from "./common.js";
import { balanced, checkSelectors, SiteEditError } from "./selectors.js";

const MAX_STYLE = 8_000;
const MAX_RULES = 60;

const PROPERTY_NAMES = new Set([
	"accent-color",
	"align-content",
	"align-items",
	"align-self",
	"aspect-ratio",
	"background",
	"background-attachment",
	"background-blend-mode",
	"background-clip",
	"background-color",
	"background-image",
	"background-origin",
	"background-position",
	"background-repeat",
	"background-size",
	"box-shadow",
	"box-sizing",
	"caret-color",
	"color",
	"color-scheme",
	"column-count",
	"column-gap",
	"column-width",
	"columns",
	"display",
	"fill",
	"filter",
	"flex",
	"flex-basis",
	"flex-grow",
	"flex-shrink",
	"flex-wrap",
	"font",
	"gap",
	"grid-template-columns",
	"height",
	"justify-content",
	"letter-spacing",
	"line-height",
	"max-height",
	"max-width",
	"min-height",
	"min-width",
	"object-fit",
	"opacity",
	"overflow",
	"overflow-wrap",
	"overflow-x",
	"overflow-y",
	"position",
	"row-gap",
	"scrollbar-color",
	"scrollbar-width",
	"stroke",
	"visibility",
	"white-space",
	"width",
	"word-break",
	"word-spacing",
]);
const PROPERTY_FAMILIES = /^(?:border|outline|margin|padding|font|text)(?:-[a-z]+)*$/;
/** Inside a family, but they draw images or their own text. */
const PROPERTY_REFUSED = /^(?:border-image|text-emphasis)/;

const FUNCTIONS = new Set([
	"rgb",
	"rgba",
	"hsl",
	"hsla",
	"hwb",
	"lab",
	"lch",
	"oklab",
	"oklch",
	"color",
	"color-mix",
	"light-dark",
	"calc",
	"min",
	"max",
	"clamp",
	"var",
	"repeat",
	"minmax",
	"fit-content",
	"linear-gradient",
	"radial-gradient",
	"conic-gradient",
	"repeating-linear-gradient",
	"repeating-radial-gradient",
	"repeating-conic-gradient",
	"blur",
	"brightness",
	"contrast",
	"drop-shadow",
	"grayscale",
	"hue-rotate",
	"invert",
	"saturate",
	"sepia",
]);

interface Rule {
	selectors: string;
	declarations: string[];
}

/** A check-only copy: `text` with each quoted string emptied, so what is inside a font name isn't read as CSS. */
function withoutStrings(text: string): string {
	return text.replace(/"[^"]*"|'[^']*'/g, '""');
}

/** Splits at `mark` outside quotes, brackets and parentheses. */
function split(text: string, mark: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = "";
	let from = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === mark && depth <= 0) {
			parts.push(text.slice(from, i));
			from = i + 1;
		}
	}
	parts.push(text.slice(from));
	return parts;
}

function checkDeclaration(raw: string): string {
	const colon = raw.indexOf(":");
	const refuse = (why: string): never => {
		throw new SiteEditError(`"${raw.trim().slice(0, 120)}": ${why}`);
	};
	if (colon < 1) return refuse("a declaration is property: value.");
	const name = raw.slice(0, colon).trim();
	const custom = /^--[a-zA-Z0-9_-]+$/.test(name);
	const property = custom ? name : name.toLowerCase();
	const value = raw
		.slice(colon + 1)
		.replace(/!\s*important\s*$/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const known = PROPERTY_NAMES.has(property) || (PROPERTY_FAMILIES.test(property) && !PROPERTY_REFUSED.test(property));
	if (!custom && !known) return refuse(`${property} isn't one a style may set.`);
	if (!value) return refuse("the value is empty.");
	if (/[!<>]/.test(value)) return refuse("a value has no ! < or >.");
	if (!balanced(value)) return refuse("unbalanced parentheses or quotes.");
	if (/["']/.test(value) && property !== "font" && property !== "font-family")
		return refuse("only a font name is quoted.");
	const bare = withoutStrings(value);
	for (const [, fn] of bare.matchAll(/([a-zA-Z_-][a-zA-Z0-9_-]*)\s*\(/g))
		if (!FUNCTIONS.has(fn.toLowerCase())) return refuse(`${fn}() isn't allowed.`);
	// "Off the page" and "over something else" both need a negative length. An angle may be negative, and so may tracking.
	if (property !== "letter-spacing")
		for (const [, unit] of bare.matchAll(/(?:^|[\s,(*/])-\.?\d[\d.]*([a-z%]*)/gi))
			if (!/^(?:deg|grad|rad|turn)$/i.test(unit)) return refuse("no negative lengths.");
	// A sum can come out negative, and only a margin or an indent would move something over the page then.
	if (/^(?:margin|text-indent)/.test(property) && bare.includes("("))
		return refuse(`${property} takes plain lengths.`);
	if (property === "position" && value.toLowerCase() !== "static") return refuse("position can only be static.");
	if (property === "opacity") {
		const amount = /^(\d*\.?\d+)(%?)$/.exec(value);
		const n = amount ? Number(amount[1]) / (amount[2] ? 100 : 1) : Number.NaN;
		if (!(n >= 0.2 && n <= 1)) return refuse("opacity goes from 0.2 to 1; hide takes something away.");
	}
	return `${property}: ${value} !important`;
}

/** The rules of `raw`, checked, or the reason the first bad one is refused. */
function parseRules(raw: string): Rule[] {
	const css = raw
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (/[\\@<]/.test(css)) throw new SiteEditError("Plain rules only: no @ rules, backslashes or <.");
	if (/\/\*|\*\//.test(css)) throw new SiteEditError("A comment isn't closed.");
	const rules: Rule[] = [];
	let rest = css;
	while (rest) {
		const open = split(rest, "{")[0].length;
		if (open === rest.length)
			throw new SiteEditError(`"${rest.slice(0, 120)}": a rule is selectors { property: value; }.`);
		const body = rest.slice(open + 1);
		const close = split(body, "}")[0].length;
		if (close === body.length) throw new SiteEditError(`"${rest.slice(0, 120)}": the rule isn't closed.`);
		const inside = body.slice(0, close);
		if (split(inside, "{").length > 1)
			throw new SiteEditError(`"${rest.slice(0, 120)}": one rule inside another isn't allowed.`);
		const declarations = split(inside, ";")
			.filter((d) => d.trim())
			.map(checkDeclaration);
		if (!declarations.length) throw new SiteEditError(`"${rest.slice(0, 120)}": the rule sets nothing.`);
		rules.push({ selectors: checkSelectors(rest.slice(0, open)), declarations });
		if (rules.length > MAX_RULES) throw new SiteEditError(`A style takes up to ${MAX_RULES} rules.`);
		rest = body.slice(close + 1).trim();
	}
	return rules;
}

/** A style edit's value from what an agent sent: the ready-made `dark`, or its rules in one canonical form, one a line. */
export function checkStyle(raw: string): string {
	const value = raw.trim();
	if (!value) throw new SiteEditError('Give CSS rules, like "body { font-size: 18px }", or dark.');
	if (value.toLowerCase() === DARK) return DARK;
	if (value.length > MAX_STYLE) throw new SiteEditError(`A style is limited to ${MAX_STYLE} characters.`);
	return parseRules(value)
		.map((r) => `${r.selectors} { ${r.declarations.join("; ")}; }`)
		.join("\n");
}

const FLIP = "invert(1) hue-rotate(180deg) !important";
/**
 * Every color turned over, and pictures, video and frames turned back. What the browser draws above the page (a dialog, a
 * popover) isn't under the page's own filter and gets its own; what is full screen gets none.
 */
const DARK_CSS = [
	`:root { filter: ${FLIP}; background-color: #fff !important; }`,
	`img, video, canvas, iframe, embed, object, [style*="background-image"] { filter: ${FLIP}; }`,
	'[style*="background-image"] :is(img, video, canvas, iframe) { filter: none !important; }',
	`dialog:modal { filter: ${FLIP}; }`,
	`[popover]:popover-open { filter: ${FLIP}; }`,
	":is(img, video, canvas, iframe):fullscreen, :fullscreen :is(img, video, canvas, iframe) { filter: none !important; }",
].join("\n");

/** The CSS a page gets for a style edit's value. */
export function styleCss(value: string): string {
	return value === DARK ? DARK_CSS : value;
}
