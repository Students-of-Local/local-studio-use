// Style edits: CSS an agent may put on a site. It recolors, resizes, spaces and hides what the site shows. It never loads
// or sends anything, adds text, or lays something over the page.
import assert from "node:assert/strict";
import { test } from "node:test";

const { checkStyle, styleCss } = await import("../src/site-edits/style.ts");
const { DARK } = await import("../src/site-edits/common.ts");
const store = await import("../src/site-edits/store.ts");
const { sitesDocument, withDocument } = await import("../src/site-edits/saved.ts");
const empty = { edits: [], adBlock: false };
const refused = (css, why) => assert.throws(() => checkStyle(css), (e) => e instanceof store.SiteEditError && (!why || why.test(e.message)), css);

test("plain rules are kept in one form, each declaration important", () => {
	assert.equal(checkStyle(".a { color: red }"), ".a { color: red !important; }");
	assert.equal(checkStyle("/* x */ .a,\n.b>c{COLOR:red!important;;\n padding : 1px  2px;}"), ".a,\n.b>c { color: red !important; padding: 1px 2px !important; }".replace("\n", " "));
	assert.equal(
		checkStyle(":root { --bg: #111; --x-y_z: 4px }\nbody { background: linear-gradient(#111, #222) }"),
		":root { --bg: #111 !important; --x-y_z: 4px !important; }\nbody { background: linear-gradient(#111, #222) !important; }",
	);
	for (const good of [
		"a:hover { text-decoration: underline }",
		'a[href*="/xy"] { color: var(--c, #fff) }',
		'body { font-family: "Inter", sans-serif; font-size: 18px; line-height: 1.6; letter-spacing: -0.02em }',
		"main { max-width: calc(100% - 40px); margin: 0 auto; grid-template-columns: repeat(3, minmax(0, 1fr)) }",
		"header { position: static; opacity: .5; filter: brightness(80%) hue-rotate(-20deg) }",
		"p { border-left: 2px solid rgb(0 0 0 / 40%); box-shadow: none; overflow-y: auto; scrollbar-width: thin }",
	])
		assert.ok(checkStyle(good), good);
});

test("nothing is loaded, read or sent", () => {
	for (const fn of ["url(https://e/x)", "URL('x')", 'image-set("x" 1x)', 'src("x")', "attr(value)", "-webkit-image-set(x)", "element(#a)", "env(x)", "paint(x)", "cross-fade(a, b)"])
		refused(`a { background: ${fn} }`);
	refused("a { background: url (x) }", /url\(\)/);
	refused("a { --x: url(https://e/x) }");
	refused('a { --x: "text" }', /font name/);
	refused("a { background: red url(https://e/x) }", /url\(\) isn't allowed/);
	for (const bad of ['@import "x";', "@font-face { src: x }", "a { b { color: red } }", "a { color: \\75rl(x) }", "</style><script>", "a { color: red", "a } b { color: red }", "/* a { color: red }", "color: red", "a {}", "{ color: red }"]) refused(bad);
});

test("nothing is added to the page or laid over it", () => {
	for (const bad of [
		"a::before { content: 'x' }",
		"a { position: fixed }",
		"a { position: absolute }",
		"a { z-index: 9 }",
		"a { inset: 0 }",
		"a { top: 0 }",
		"a { transform: scale(2) }",
		"a { translate: 10px }",
		"a { pointer-events: none }",
		"a { clip-path: none }",
		"a { mask: none }",
		"a { animation: x 1s }",
		"a { transition: all 1s }",
		"a { cursor: none }",
		"a { order: 2 }",
		"a { list-style-type: 'x' }",
		"a { border-image: none }",
		"a { text-emphasis: 'x' }",
		"a { user-select: none }",
		"a { behavior: x }",
		"a { -moz-binding: x }",
		"a { margin: -10px }",
		"a { margin: 0 -1.5em }",
		"a { margin-top: calc(0px - 100px) }",
		"a { margin: var(--m) }",
		"a { text-indent: calc(0px - 999px) }",
		"a { text-shadow: -900px 0 red }",
		"a { --m: -10px }",
		"a { width: calc(10px*-1) }",
		"a { opacity: 0 }",
		"a { opacity: 10% }",
		"a { opacity: var(--o) }",
		"a { opacity: calc(0) }",
		"a { filter: opacity(0) }",
	])
		refused(bad);
});

test("limits, and what a refusal says", () => {
	refused("");
	refused("a { color: red } ".repeat(61), /60 rules/);
	refused(`a { color: ${"r".repeat(8000)} }`, /8000/);
	refused(".a { color: red } .b { z-index: 4 }", /"z-index: 4": z-index isn't one a style may set/);
});

test("a style at the limit passes the same check again: its Undo works, and a kept copy of it is taken", () => {
	// The smallest declarations, which the kept form makes longest, and exactly as many as fit.
	const raw = `a{${Array(1333).fill("gap:0").join(";")}}`;
	assert.equal(raw.length, 8000);
	const kept = checkStyle(raw);
	assert.ok(kept.length > 3 * raw.length);
	assert.equal(checkStyle(kept), kept);
	const wide = checkStyle(Array.from({ length: 60 }, (_, i) => `.a${i}{--${"b".repeat(100)}:0;gap:0}`).join(" "));
	assert.equal(checkStyle(wide), wide);
	refused(`a{${Array(1334).fill("gap:0").join(";")}}`, /8000/);
	refused(`a { color: red } /* ${"x".repeat(40_000)} */`, /8000/);
	const first = store.added(empty, { host: "x.com", kind: "style", value: raw, actor: "agent", who: "claude" }, "s1", 1);
	const tuned = store.updated(first.state, "s1", "a { color: red }");
	assert.equal(store.updated(tuned, "s1", first.edit.value).edits[0].value, kept, "the card's Undo");
	const taken = withDocument(empty, sitesDocument(first.state), [], () => "n1", 2);
	assert.deepEqual([taken.added, taken.leftOut, taken.state.edits[0].value], [1, 0, kept]);
});

test("a style is one edit, on at once, in the page's sheet before the hides", () => {
	const add = (s, kind, value, id) => store.added(s, { host: "x.com", kind, value, actor: "agent", who: "claude" }, id, 1);
	const one = add(empty, "style", ".a { color: red }", "s1");
	assert.equal(one.edit.on, true);
	assert.equal(add(one.state, "style", ".a{color:red}", "s2").edit.id, "s1", "the same look is one edit");
	const both = add(one.state, "hide", ".ad", "h1").state;
	assert.equal(store.pageCss(both, "https://x.com/"), ".a { color: red !important; }\n.ad { display: none !important; }");
	assert.equal(store.pageCss(both, "https://example.com/"), "");
	assert.equal(store.pageCss(store.switched(both, "s1", false, "agent"), "https://x.com/"), ".ad { display: none !important; }");
	assert.throws(() => add(empty, "style", "a { position: fixed }", "s3"), store.SiteEditError);
});

test("dark is ready-made", () => {
	assert.equal(checkStyle(" Dark "), DARK);
	assert.match(styleCss(DARK), /^:root \{ filter: invert\(1\)/);
	assert.doesNotMatch(styleCss(DARK), /url|@/);
});

test("an edit's value is changed in place, checked the same, and never a script's", () => {
	const s = store.added(empty, { host: "x.com", kind: "style", value: ".a { color: red }", actor: "agent", who: "c" }, "s1", 1).state;
	const next = store.updated(s, "s1", ".a { color: blue }", "bluer").edits[0];
	assert.deepEqual([next.id, next.on, next.value, next.note], ["s1", true, ".a { color: blue !important; }", "bluer"]);
	assert.equal(store.updated(store.switched(s, "s1", false, "person"), "s1", ".a { color: blue }").edits[0].on, false, "off stays off");
	assert.throws(() => store.updated(s, "s1", "a { position: fixed }"), store.SiteEditError);
	assert.throws(() => store.updated(s, "nope", "a { color: red }"), store.SiteEditError);
	const script = store.added(empty, { host: "x.com", kind: "script", value: "1", actor: "agent", who: "c" }, "j1", 1).state;
	assert.throws(() => store.updated(script, "j1", "2"), /can't be changed in place/);
});
