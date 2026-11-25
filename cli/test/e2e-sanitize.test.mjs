// Notebook HTML is untrusted and is shown in a page with extension privileges. This bundles
// src/artifacts/preview/sanitize.ts and runs it in Chromium: every vector must leave only allowed
// tags and attributes, before and after a serialize and reparse round trip, and run no script.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PNG = "data:image/png;base64,iVBORw0KGgo=";

const VECTORS = {
	"mXSS math/mtext/table/mglyph/style": "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
	"mXSS math/mtext/mglyph/svg/style": "<math><mtext><h1><a><h6></a></h6><mglyph><svg><mtext><style><a title=\"</style><img src onerror=alert(1)>\">",
	"mXSS form/math/mtext nesting": "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
	"mXSS noscript title": "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
	"mXSS svg/p/style": "<svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">",
	"svg animate onbegin": "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
	"svg set href to javascript": "<svg><a><set attributeName=href to=javascript:alert(1) /><text x=20 y=20>x</text></a></svg>",
	"javascript href": '<a href="javascript:alert(1)">x</a>',
	"entity-encoded javascript href": '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
	"hex entity javascript href": '<a href="&#x6A;avascript&#x3A;alert(1)">x</a>',
	"tab inside javascript href": '<a href="jav&#x09;ascript:alert(1)">x</a>',
	"newline inside javascript href": '<a href="java&#10;script:alert(1)">x</a>',
	"leading space and case in href": '<a href="  JaVaScRiPt:alert(1)">x</a>',
	"data html href": '<a href="data:text/html,<script>alert(1)</script>">x</a>',
	"vbscript href": '<a href="vbscript:msgbox(1)">x</a>',
	"iframe srcdoc": '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
	"srcdoc on an allowed tag": '<div srcdoc="<script>alert(1)</script>">x</div>',
	"button formaction": '<form><button formaction="javascript:alert(1)">x</button></form>',
	"input formaction": '<input type=submit formaction="javascript:alert(1)">',
	"formaction on an allowed tag": '<p formaction="javascript:alert(1)">x</p>',
	"style expression": "<style>p{width:expression(alert(1))}</style><p>x</p>",
	"style url javascript": "<style>body{background:url(javascript:alert(1))}</style>",
	"style attribute url javascript": '<p style="background:url(javascript:alert(1))">x</p>',
	"style attribute expression": '<div style="width:expression(alert(1))">x</div>',
	"img onerror": "<img src=x onerror=alert(1)>",
	"img javascript src": '<img src="javascript:alert(1)">',
	"img svg data src": '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+">',
	"img remote src": '<img src="https://evil.example/t.gif">',
	"event handler on allowed tag": '<p onclick="alert(1)" onmouseover=alert(1)>x</p>',
	"details ontoggle": "<details open ontoggle=alert(1)><summary>x</summary></details>",
	"script tag": "<script>alert(1)</script>",
	"script split by null": "<scr\u0000ipt>alert(1)</scr\u0000ipt>",
	"object data": '<object data="javascript:alert(1)"></object>',
	"embed src": '<embed src="javascript:alert(1)">',
	"meta refresh": '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
	"base href": '<base href="javascript:alert(1)//">',
	"link stylesheet": '<link rel=stylesheet href="https://evil.example/x.css">',
	"template content": "<template><img src=x onerror=alert(1)></template>",
	"comment breakout": "<!--<img src=x onerror=alert(1)>--><p>x</p>",
	"comment with dashes": "<!-- --!><img src=x onerror=alert(1)> -->",
	"xmp raw text": "<xmp><img src=x onerror=alert(1)></xmp>",
	"textarea raw text": "<textarea><img src=x onerror=alert(1)></textarea>",
	"noembed raw text": "<noembed><img src=x onerror=alert(1)></noembed>",
	"select/style bypass": "<select><style></select><img src=x onerror=alert(1)></style></select>",
	"DOM clobbering id": '<img name=attributes src="data:image/png;base64,AA=="><form id=x><input name=y></form>',
	"xlink href": '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
	"math href": '<math href="javascript:alert(1)">x</math>',
	"foreignObject html": "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
	"annotation-xml": '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
	"uppercase tag and handler": "<IMG SRC=x ONERROR=alert(1)>",
	"unquoted backtick handler": "<img src=x onerror=`alert(1)`>",
	"nested anchor in table": "<table><a href=javascript:alert(1)><tr><td>x</td></tr></a></table>",
};

/** Runs in the page: sanitize `html`, attach it, round-trip it, and list what breaks the allow list. */
function probe({ html, resolved, budget }) {
	const allowed = new Set(
		"a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub summary sup table tbody td tfoot th thead tr u ul var".split(" "),
	);
	const common = ["title", "colspan", "rowspan", "align", "valign", "dir", "lang"];
	const own = { a: ["href", "target", "rel"], img: ["src", "alt", "width", "height"], ol: ["start", "type"], td: ["headers", "scope"], th: ["headers", "scope"] };
	const problems = [];
	const check = (where, node) => {
		for (const el of node.querySelectorAll("*")) {
			const tag = el.localName;
			if (!allowed.has(tag) || el.namespaceURI !== "http://www.w3.org/1999/xhtml") problems.push(`${where}: <${tag}>`);
			for (const a of el.attributes) {
				if (!common.includes(a.name) && !own[tag]?.includes(a.name)) problems.push(`${where}: ${tag}[${a.name}]`);
				if (a.name === "href" && !/^(https?:|mailto:)/i.test(a.value)) problems.push(`${where}: href ${a.value}`);
				if (a.name === "src" && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(a.value)) problems.push(`${where}: src ${a.value}`);
			}
		}
	};
	const host = document.createElement("div");
	const left = budget === undefined ? undefined : { nodes: budget };
	host.appendChild(Sanitize.sanitizeHtml(html, document, left, (src) => resolved?.[src]));
	document.body.replaceChildren(host);
	check("output", host);
	const again = document.createElement("div");
	again.innerHTML = host.innerHTML;
	document.body.appendChild(again);
	check("reparsed", again);
	return { html: host.innerHTML, text: host.textContent, problems };
}

let browser;
let server;
let page;
let origin;

before(async () => {
	const { outputFiles } = await build({
		entryPoints: [join(root, "src/artifacts/preview/sanitize.ts")],
		bundle: true,
		write: false,
		format: "iife",
		globalName: "Sanitize",
		target: "es2022",
	});
	const csp = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8")).content_security_policy.extension_pages;
	server = createServer((req, res) => {
		if (req.url === "/sanitize.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(outputFiles[0].text);
		const headers = { "content-type": "text/html" };
		if (req.url === "/csp") headers["content-security-policy"] = csp;
		res.writeHead(200, headers).end("<!doctype html><body><script src=/sanitize.js></script>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath: process.env.LOCAL_STUDIO_BROWSER_E2E_CHROMIUM || undefined });
	page = await browser.newPage();
	// Nothing leaves the machine, and a remote fetch by the output fails the test that made it.
	await page.route((url) => url.origin !== origin, (route) => route.abort());
	await page.exposeFunction("__ran", () => ran++);
	await page.addInitScript(() => {
		window.alert = () => window.__ran();
	});
	page.on("request", (r) => {
		if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) remote.push(r.url());
	});
});

after(async () => {
	await browser?.close();
	server?.close();
});

let ran = 0;
const remote = [];

/** One vector on a page with no CSP, so a surviving handler would run. */
async function run(args) {
	ran = 0;
	remote.length = 0;
	await page.goto(origin);
	const result = await page.evaluate(probe, args);
	await page.evaluate(() => document.querySelectorAll("a").forEach((a) => a.href.startsWith("javascript:") && a.click()));
	await page.waitForTimeout(100);
	return { ...result, ran, remote: [...remote] };
}

test("the bench sees a live handler: raw innerHTML runs the first vector family", async () => {
	ran = 0;
	await page.goto(origin);
	await page.evaluate(() => {
		document.body.innerHTML = "<img src=x onerror=alert(1)>";
	});
	await page.waitForTimeout(200);
	assert.equal(ran, 1);
});

for (const [name, html] of Object.entries(VECTORS)) {
	test(`blocks: ${name}`, async () => {
		const r = await run({ html });
		assert.deepEqual(r.problems, [], r.html);
		assert.equal(r.ran, 0, r.html);
		assert.deepEqual(r.remote, [], r.html);
	});
}

test("the bundle loads and works under the extension pages' own CSP", async () => {
	const errors = [];
	const seen = (m) => m.type() === "error" && errors.push(m.text());
	page.on("console", seen);
	await page.goto(`${origin}/csp`);
	const r = await page.evaluate(probe, { html: "<p class=c>x<b>y</b></p>" });
	page.off("console", seen);
	assert.equal(r.html, "<p>x<b>y</b></p>");
	assert.deepEqual(errors, []);
});

test("keeps the markup the previews need, exactly", async () => {
	const html = `<h2 title="t">H</h2><p>a <b>b</b> <code>c</code> <a href="mailto:a@example.com">m</a></p><table><thead><tr><th scope="col" colspan="2">H</th></tr></thead><tbody><tr><td align="right">1</td><td headers="h">2</td></tr></tbody></table><ol start="3" type="a"><li>x</li></ol><img src="${PNG}" alt="pic" width="10" height="20"><details><summary>s</summary>d</details>`;
	const r = await run({ html });
	assert.equal(r.html, html.replace('com">', 'com" target="_blank" rel="noopener noreferrer">'));
});

test("links keep only http, https and mailto, and attributes stay on their own tags", async () => {
	const r = await run({ html: '<a href="/local">a</a><a href="tel:1">b</a><a href="HTTPS://x.example/">c</a><p href="https://x.example/" src="x" width="1">d</p>' });
	assert.equal(r.html, '<a>a</a><a>b</a><a href="HTTPS://x.example/" target="_blank" rel="noopener noreferrer">c</a><p>d</p>');
});

test("style, class, id, name, data- and aria- attributes are dropped", async () => {
	const r = await run({ html: '<p style="color:red" class="c" id="i" name="n" data-x="1" aria-label="l">x</p>' });
	assert.equal(r.html, "<p>x</p>");
});

test("a blocked image becomes its alt text, and attachments resolve only to inline images", async () => {
	const html = '<img src="https://x.example/a.png" alt="chart"><img src="x"><img src="attachment:a" alt="a"><img src="attachment:b" alt="b">';
	const r = await run({ html, resolved: { "attachment:a": PNG, "attachment:b": "data:text/html,x" } });
	assert.equal(r.html, `[Image: chart][Image]<img src="${PNG}" alt="a">[Image: b]`);
});

test("text that looks like markup, and a tag named like an Object.prototype key, come through as text", async () => {
	const html = "<pre><code>&lt;div onclick=x&gt;&lt;/div&gt; a &amp;&amp; b --&gt;</code></pre>";
	assert.equal((await run({ html })).text, "<div onclick=x></div> a && b -->");
	assert.equal((await run({ html: "<constructor title=t a=b>x</constructor>" })).html, "x");
});

test("unknown wrappers keep their text, dropped elements lose theirs", async () => {
	const r = await run({ html: "<section><x-y>kept</x-y></section><script>no</script><style>no</style><form>no<input></form><select><option>no</select><button>no</button><svg><text>no</text></svg><video>no</video><canvas>no</canvas><object>no</object>" });
	assert.equal(r.text, "kept");
});

test("the node budget is shared across calls, depth is capped and oversized input is refused", async () => {
	await page.goto(origin);
	const r = await page.evaluate(() => {
		const size = (f) => document.createNodeIterator(f, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		const count = (f) => {
			const it = size(f);
			let n = 0;
			while (it.nextNode()) n++;
			return n;
		};
		const budget = { nodes: 25 };
		const call = () => count(Sanitize.sanitizeHtml("<p>x</p>".repeat(10), document, budget));
		const counts = [call(), call(), call()];
		const deep = Sanitize.sanitizeHtml(`${"<div>".repeat(300)}bottom`, document);
		let depth = 0;
		for (let el = deep.firstElementChild; el; el = el.firstElementChild) depth++;
		const big = Sanitize.sanitizeHtml("x".repeat(5_000_001), document).textContent;
		return { counts, depth, big };
	});
	assert.deepEqual(r.counts, [20, 5, 0]);
	assert.ok(r.depth >= 60 && r.depth <= 65, `depth ${r.depth}`);
	assert.equal(r.big, "[Output too large to display]");
});
