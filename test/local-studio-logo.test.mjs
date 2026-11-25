// The extension's logo is Local Studio's own mark: the code matches docs/brand, each manifest icon is a real PNG of its
// size, and no color of an earlier theme is left.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SVG } from "../media/brand/build.mjs";
import { LOCAL_STUDIO_MARK, LOCAL_STUDIO_MARK_MONO } from "../src/components/local-studio-svg.ts";
import { uniqueSvgIds } from "../src/components/svg-ids.ts";
import { contrast, mix } from "../src/appearance/palettes.ts";
import { appearanceVariables } from "../src/appearance/tokens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the logo in the code is the one in docs/brand", () => {
	// build.mjs reads docs/brand; importing it renders nothing.
	assert.equal(LOCAL_STUDIO_MARK, SVG.mark);
	assert.equal(LOCAL_STUDIO_MARK_MONO, SVG.mono);
	assert.match(LOCAL_STUDIO_MARK, /#E58A4E/);
	assert.match(LOCAL_STUDIO_MARK_MONO, /currentColor/);
	assert.doesNotMatch(LOCAL_STUDIO_MARK_MONO, /#[0-9a-f]{3,6}\b/i, "the one-color mark takes its color from the text around it");
});

test("the default colors are Local Studio's cream, ink and amber, and none of an earlier theme's", () => {
	const css = read("src/app.css");
	for (const name of ["background", "card", "border", "primary"]) {
		for (const dark of [false, true]) {
			const block = dark ? css.slice(css.indexOf("\n.dark {")) : css.slice(css.indexOf("\n:root {"));
			const value = new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
			assert.equal(value, appearanceVariables({ preset: "standard" }, dark)[`--${name}`], `app.css ${dark ? "dark" : "light"} --${name} is the preset's`);
		}
	}
	for (const file of ["src/app.css", "src/appearance/palettes.ts", "src/components/local-studio-svg.ts", "src/tools/repl/overlay-content.ts", "src/attention/badge.ts"])
		assert.doesNotMatch(read(file), /#(?:1b4ed8|5b84ff|346bf1|7c9cff|2a3fe0|e3a93b|0f1b24|59693f|b8642e)\b/i, file);
});

test("each manifest icon is a real PNG of its size", () => {
	const manifest = JSON.parse(read("static/manifest.chrome.json"));
	assert.deepEqual(Object.keys(manifest.icons).sort((a, b) => a - b), ["16", "32", "48", "128"]);
	for (const [size, file] of Object.entries(manifest.icons)) {
		const png = readFileSync(join(root, "static", file));
		assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is a PNG`);
		assert.equal(png.toString("latin1", 12, 16), "IHDR", file);
		assert.equal(png.readUInt32BE(16), Number(size), `${file} width`);
		assert.equal(png.readUInt32BE(20), Number(size), `${file} height`);
	}
});

test("two copies of the icon on one page each paint from their own gradient", () => {
	const a = uniqueSvgIds(LOCAL_STUDIO_MARK);
	const b = uniqueSvgIds(LOCAL_STUDIO_MARK);
	const ids = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	const refs = (svg) => [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
	assert.ok(ids(a).length > 0, "the icon defines its gradient");
	assert.notDeepEqual(ids(a), ids(b));
	for (const svg of [a, b]) for (const ref of refs(svg)) assert.ok(ids(svg).includes(ref), `url(#${ref}) points into its own copy`);
	assert.equal(uniqueSvgIds(LOCAL_STUDIO_MARK_MONO), LOCAL_STUDIO_MARK_MONO, "an SVG without ids is left as it is");
	assert.match(read("src/components/LocalStudioMark.ts"), /uniqueSvgIds\(LOCAL_STUDIO_MARK\)/);
});

test("the ask chip's text reaches 4.5:1 on its own tinted fill, in light and dark", () => {
	const css = read("src/app.css");
	assert.match(css, /\n\.tk-ask-chip \{[^}]*color: var\(--tk-accent-text\)/, "chip text uses the lifted accent text");
	for (const dark of [false, true]) {
		const v = appearanceVariables({ preset: "standard" }, dark);
		const text = v["--tk-accent-text"];
		const fill = mix(v["--card"], v["--tk-accent"], 0.14);
		assert.ok(contrast(text, fill) >= 4.5, `${dark ? "dark" : "light"}: ${text} on ${fill} is ${contrast(text, fill).toFixed(2)}:1`);
	}
	// app.css's own values, used before Appearance applies a preset.
	const own = (block, name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
	const light = css.slice(css.indexOf("\n:root {"), css.indexOf("\n.dark {"));
	const night = css.slice(css.indexOf("\n.dark {"));
	assert.ok(contrast(own(night, "tk-accent-text"), mix(own(night, "card"), own(night, "tk-accent"), 0.14)) >= 4.5);
	for (const name of ["background", "card", "secondary"]) assert.ok(contrast(own(light, "tk-accent-text"), own(light, name)) >= 4.5, name);
});
