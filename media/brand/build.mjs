// Draws the extension's mark, a pointer cut from a disc, and writes every brand file from it (see BRAND.md):
//   media/brand/icon.svg, icon-16.svg, mark.svg, mark-blue.svg, icon-macos.svg, icon-macos-dark.svg
//   static/icon-{16,32,48,128}.png         the extension's icons
//   media/brand/hero.png, hero-light.png   README hero for dark and light themes
//   media/brand/social.png                 GitHub social preview (1280x640)
// Run after changing the geometry or the palette: node media/brand/build.mjs (--svg writes only the SVGs).
// Rendering uses the CLI's Playwright Chromium (or TYCHICUS_CHROMIUM), headless, with a mock keychain.
//   src/components/tychicus-svg.ts         the same icons as strings for the side panel
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

/**
 * Local Studio's colors (baney75/local-studio: macos/AppIcon.icon and the default theme in
 * BuiltInThemeData.swift). The extension is part of Local Studio, so it wears the same blue.
 */
export const PALETTE = {
	glassLight: "#b6c8ff",
	glass: "#5b84ff",
	glassDeep: "#2a3fe0",
	accent: "#1b4ed8",
	accentDark: "#346bf1",
	ink: "#27272a",
	muted: "#71717b",
	canvas: "#fcfcfc",
	night: "#0a0a0a",
	nightText: "#f5f5f5",
	nightMuted: "#9a9aa3",
};

const f = (n) => Number(n.toFixed(2)).toString();

// The pointer on a 1024 grid, tip up and to the left, in a disc of radius 410 at the center (Local Studio's disc).
const POINTER = [
	[404, 270],
	[404, 724],
	[506, 628],
	[576, 768],
	[656, 730],
	[586, 592],
	[728, 592],
];

/** Rounds every corner of a closed polygon with radius r (concave corners too), as an SVG path. */
function filleted(points, r) {
	const n = points.length;
	let d = "";
	for (let i = 0; i < n; i++) {
		const p = points[(i + n - 1) % n];
		const c = points[i];
		const q = points[(i + 1) % n];
		const a = [p[0] - c[0], p[1] - c[1]];
		const b = [q[0] - c[0], q[1] - c[1]];
		const la = Math.hypot(...a);
		const lb = Math.hypot(...b);
		const ua = [a[0] / la, a[1] / la];
		const ub = [b[0] / lb, b[1] / lb];
		const angle = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])));
		const t = Math.min(r / Math.tan(angle / 2), la / 2, lb / 2);
		const rr = t * Math.tan(angle / 2);
		const s = [c[0] + ua[0] * t, c[1] + ua[1] * t];
		const e = [c[0] + ub[0] * t, c[1] + ub[1] * t];
		// The turn from the incoming edge to the outgoing one sets the arc's direction.
		const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
		d += `${i === 0 ? "M" : "L"}${f(s[0])} ${f(s[1])}A${f(rr)} ${f(rr)} 0 0 ${cross > 0 ? 1 : 0} ${f(e[0])} ${f(e[1])}`;
	}
	return `${d}Z`;
}

/** The disc and the pointer on a grid of `size`, the disc of `radius` at the center: one evenodd path, the pointer a hole. */
function markPath(size, radius, round) {
	const k = radius / 410;
	const c = size / 2;
	const pts = POINTER.map(([x, y]) => [c + (x - 512) * k, c + (y - 512) * k]);
	const disc = `M${f(c - radius)} ${f(c)}A${f(radius)} ${f(radius)} 0 1 1 ${f(c + radius)} ${f(c)}A${f(radius)} ${f(radius)} 0 1 1 ${f(c - radius)} ${f(c)}Z`;
	return disc + filleted(pts, round * k);
}

/** Local Studio's icon gradient, on the same diagonal as its AppIcon body. */
const glass = (id, size) =>
	`<linearGradient id="${id}" x1="${f(size * 0.293)}" y1="${f(size * 0.244)}" x2="${f(size * 0.684)}" y2="${f(size * 0.772)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PALETTE.glassLight}"/><stop offset=".55" stop-color="${PALETTE.glass}"/><stop offset="1" stop-color="${PALETTE.glassDeep}"/></linearGradient>`;

const flat = (color, size = 64, radius = 28) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><path fill="${color}" fill-rule="evenodd" d="${markPath(size, radius, size === 16 ? 40 : 30)}"/></svg>`;

/** Mac app tiles, light and dark, filled as Local Studio's AppIcon.icon is, with its sheen. */
const tile = (dark) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="tk-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark ? "#24252c" : "#ffffff"}"/><stop offset="1" stop-color="${dark ? "#0b0b0e" : "#e9edf5"}"/></linearGradient>${glass("tk-g1024", 1024)}<radialGradient id="tk-sheen" cx="380" cy="300" r="440" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tk-tile)"/><path fill="url(#tk-g1024)" fill-rule="evenodd" d="${markPath(1024, 300, 30)}"/><path fill="url(#tk-sheen)" fill-rule="evenodd" d="${markPath(1024, 300, 30)}"/></svg>`;

export const SVG = {
	// The app icon, 32 px and up: the mark in the glass gradient.
	icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${glass("tk-g64", 64)}</defs><path fill="url(#tk-g64)" fill-rule="evenodd" d="${markPath(64, 28, 30)}"/></svg>`,
	// 16 px: flat accent and a rounder pointer, because the gradient's light end washes out the tip at that size.
	"icon-16": flat(PALETTE.accentDark, 16, 7.5),
	// One-color marks for type and backgrounds.
	mark: flat(PALETTE.ink),
	"mark-blue": flat(PALETTE.accentDark),
	// In src/components/tychicus-svg.ts as TYCHICUS_MARK: takes the color of the text around it.
	"mark-current": flat("currentColor"),
	"icon-macos": tile(false),
	"icon-macos-dark": tile(true),
};

const fonts = join(here, "node_modules", "@fontsource");
/** Fonts inlined as data URLs: a page from setContent cannot read file:// URLs. */
const font = (pkg, file) =>
	`url(data:font/woff2;base64,${readFileSync(join(fonts, pkg, "files", file)).toString("base64")})`;
const fontFaces = () => `
@font-face { font-family: "Instrument Sans"; font-weight: 400; src: ${font("instrument-sans", "instrument-sans-latin-400-normal.woff2")}; }
@font-face { font-family: "Instrument Sans"; font-weight: 600; src: ${font("instrument-sans", "instrument-sans-latin-600-normal.woff2")}; }
@font-face { font-family: "JetBrains Mono"; src: ${font("jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}; }`;

const dataUrl = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;

const LINE = "You send the work. Local Studio carries it out.";
const WHAT = "Browser use and computer use for your coding agents, on your own machine, under your command.";
/** The harnesses named on the hero; the social card drops the last item to fit its footer. */
const HARNESS_NAMES = "Claude Code · Codex · pi · OMP · OpenCode · Cursor";
const HARNESSES = `${HARNESS_NAMES} · any MCP client`;

/** Colors per theme, from Local Studio's default theme. The line is the accent, lifted on night so it reads. */
const THEMES = {
	dark: { surface: PALETTE.night, word: PALETTE.nightText, line: "#7c9cff", sub: PALETTE.nightMuted },
	light: { surface: PALETTE.canvas, word: PALETTE.ink, line: PALETTE.accent, sub: PALETTE.muted },
};

/** README hero: mark, wordmark, the line, the harnesses. */
function banner(width, height, theme = "dark") {
	const t = THEMES[theme];
	return `<!doctype html><html><head><style>${fontFaces()}
	html, body { margin: 0; }
	.card { width: ${width}px; height: ${height}px; box-sizing: border-box; background: ${t.surface}; color: ${t.word};
		display: flex; align-items: center; gap: 56px; padding: 0 88px; font-family: "Instrument Sans", sans-serif; position: relative; overflow: hidden; }
	.wake { position: absolute; right: -${Math.round(height * 0.5)}px; top: 50%; width: ${Math.round(height * 1.6)}px; height: ${Math.round(height * 1.6)}px;
		transform: translateY(-50%); opacity: ${theme === "dark" ? 0.08 : 0.07}; }
	.mark { width: ${Math.round(height * 0.44)}px; height: ${Math.round(height * 0.44)}px; flex: none; }
	.word { font-weight: 600; font-size: ${Math.round(height * 0.2)}px; letter-spacing: -0.035em; line-height: 1; }
	.line { font-weight: 400; font-size: ${Math.round(height * 0.07)}px; color: ${t.line}; margin-top: 18px; letter-spacing: -0.01em; }
	.sub { font-family: "JetBrains Mono"; font-size: ${Math.round(height * 0.036)}px; color: ${t.sub}; margin-top: 26px; letter-spacing: 0.01em; }
	</style></head><body><div class="card">
	<img class="wake" src="${dataUrl(SVG["mark-blue"])}">
	<img class="mark" src="${dataUrl(SVG.icon)}">
	<div><div class="word">Local Studio</div>
	<div class="line">${LINE}</div>
	<div class="sub">${HARNESSES}</div></div>
	</div></body></html>`;
}

/** Social cards: GitHub's preview (1280x640). A shared link shows the card alone. */
function socialCard(width, height) {
	const t = THEMES.dark;
	return `<!doctype html><html><head><style>${fontFaces()}
	html, body { margin: 0; }
	.card { width: ${width}px; height: ${height}px; box-sizing: border-box; background: ${t.surface}; color: ${t.word};
		padding: 84px 96px 72px; font-family: "Instrument Sans", sans-serif; position: relative; overflow: hidden;
		display: flex; flex-direction: column; }
	.wake { position: absolute; right: -230px; top: 50%; width: 760px; height: 760px; transform: translateY(-50%); opacity: 0.08; }
	.head { display: flex; align-items: center; gap: 34px; }
	.mark { width: 120px; height: 120px; flex: none; }
	.word { font-weight: 600; font-size: 112px; letter-spacing: -0.035em; line-height: 1; }
	.line { font-size: 46px; color: ${t.line}; margin-top: 44px; line-height: 1.15; letter-spacing: -0.01em; }
	.what { font-weight: 400; font-size: 31px; line-height: 1.4; color: ${t.word}; opacity: 0.86; margin-top: 22px; max-width: 900px; }
	.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: baseline;
		font-family: "JetBrains Mono"; font-size: 21px; color: ${t.sub}; letter-spacing: 0.01em; white-space: nowrap; position: relative; }
	</style></head><body><div class="card">
	<img class="wake" src="${dataUrl(SVG["mark-blue"])}">
	<div class="head"><img class="mark" src="${dataUrl(SVG.icon)}"><div class="word">Local Studio</div></div>
	<div class="line">${LINE}</div>
	<div class="what">${WHAT}</div>
	<div class="foot"><span>${HARNESS_NAMES}</span><span>github.com/baney75/tychicus</span></div>
	</div></body></html>`;
}

function writeSvgs() {
	for (const name of ["icon", "icon-16", "mark", "mark-blue", "icon-macos", "icon-macos-dark"])
		writeFileSync(join(here, `${name}.svg`), `${SVG[name]}\n`);
	writeFileSync(join(repo, "src", "components", "tychicus-svg.ts"), tychicusSvgModule());
}

/** src/components/tychicus-svg.ts, as biome formats it. */
function tychicusSvgModule() {
	return `// Written by media/brand/build.mjs; edit that script and run it, never this file.
// The extension's logo: a pointer cut from a disc, in Local Studio's blue glass gradient. test/tychicus-logo.test.mjs fails
// when these drift from media/brand. The 16 px icon is the flat accent with a rounder pointer, which would wash out in the
// gradient. The mark is the same shape in currentColor. TYCHICUS_ICON's gradient id is made unique per copy by uniqueSvgIds.
export const TYCHICUS_ICON = \`${SVG.icon}\`;
export const TYCHICUS_ICON_16 = \`${SVG["icon-16"]}\`;
export const TYCHICUS_MARK = \`${SVG["mark-current"]}\`;
`;
}

async function main() {
	writeSvgs();
	if (process.argv.includes("--svg")) return;
	const { chromium } = await import("../../cli/node_modules/playwright-core/index.mjs");
	// TYCHICUS_CHROMIUM names another Chromium when Playwright's own build isn't downloaded.
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.TYCHICUS_CHROMIUM || undefined,
		args: ["--use-mock-keychain", "--password-store=basic"],
	});
	try {
		const shoot = async (html, width, height, scale, out, transparent) => {
			const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
			await page.setContent(html);
			await page.evaluate(() => document.fonts.ready);
			mkdirSync(dirname(out), { recursive: true });
			await page.screenshot({ path: out, omitBackground: transparent });
			await page.close();
		};
		const iconPage = (svg, size) =>
			`<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${dataUrl(svg)}"></body></html>`;
		await shoot(iconPage(SVG["icon-16"], 16), 16, 16, 1, join(repo, "static", "icon-16.png"), true);
		for (const size of [32, 48, 128]) await shoot(iconPage(SVG.icon, size), size, size, 1, join(repo, "static", `icon-${size}.png`), true);
		await shoot(banner(1280, 400), 1280, 400, 2, join(here, "hero.png"), false);
		await shoot(banner(1280, 400, "light"), 1280, 400, 2, join(here, "hero-light.png"), false);
		await shoot(socialCard(1280, 640), 1280, 640, 1, join(here, "social.png"), false);
	} finally {
		await browser.close();
	}
}

// Importing this module for PALETTE or SVG must not re-render every asset.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
