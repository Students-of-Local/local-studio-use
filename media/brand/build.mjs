// Writes the extension's copies of Local Studio's mark (docs/brand at the top of this repository; see BRAND.md):
//   src/components/local-studio-svg.ts     the mark as strings, for the side panel and the in-page bar
//   static/icon-{16,32,48,128}.png         the extension's icons
// Run after docs/brand changes: node media/brand/build.mjs (--svg writes only the strings).
// Rendering uses the CLI's Playwright Chromium (or LOCAL_STUDIO_BROWSER_CHROMIUM), headless, with a mock keychain.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const browserRoot = join(here, "..", "..");
const brand = join(browserRoot, "docs", "brand");

/** Ids the panel can tell from a page's own, and no fixed size: the caller's box sets it. */
const prepare = (svg) =>
	svg
		.trim()
		.replace(/ width="\d+" height="\d+"/, "")
		.replace(/ id="(\w+)"/g, ' id="ls-$1"')
		.replace(/url\(#(\w+)\)/g, "url(#ls-$1)");

export const SVG = {
	mark: prepare(readFileSync(join(brand, "mark.svg"), "utf8")),
	mono: prepare(readFileSync(join(brand, "mark-mono.svg"), "utf8")),
};

const dataUrl = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;

/** src/components/local-studio-svg.ts, as biome formats it. */
const svgModule = () => `// Written by media/brand/build.mjs from docs/brand; change the mark there and run it, never this file.
export const LOCAL_STUDIO_MARK = \`${SVG.mark}\`;
/** One color: takes the color of the text around it. */
export const LOCAL_STUDIO_MARK_MONO = \`${SVG.mono}\`;
`;

async function main() {
	writeFileSync(join(browserRoot, "src", "components", "local-studio-svg.ts"), svgModule());
	if (process.argv.includes("--svg")) return;
	const { chromium } = await import("../../cli/node_modules/playwright-core/index.mjs");
	// LOCAL_STUDIO_BROWSER_CHROMIUM names another Chromium when Playwright's own build isn't downloaded.
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.LOCAL_STUDIO_BROWSER_CHROMIUM || undefined,
		args: ["--use-mock-keychain", "--password-store=basic"],
	});
	try {
		for (const size of [16, 32, 48, 128]) {
			const page = await browser.newPage({ viewport: { width: size, height: size } });
			await page.setContent(
				`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${dataUrl(SVG.mark)}">`,
			);
			await page.evaluate(() => document.images[0].decode());
			await page.screenshot({ path: join(browserRoot, "static", `icon-${size}.png`), omitBackground: true });
			await page.close();
		}
	} finally {
		await browser.close();
	}
}

// Importing this module for SVG must not render anything.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
