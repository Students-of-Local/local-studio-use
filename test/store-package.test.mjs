// The Chrome Web Store copy: what the zip holds, how a copy knows it came from the store, and that
// every permission has a written reason.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importMap, LIBRARY_DIR, NOTICES_FILE, sandboxLibraries } from "../scripts/sandbox-libraries.mjs";
import {
	askedPermissions,
	CDN_HOSTS,
	explainedPermissions,
	prepare,
	problems,
	remoteSources,
	storeSandboxCsp,
} from "../scripts/store-package.mjs";
import { storeVendorPrompts } from "../scripts/store-prompts.mjs";
import {
	RELEASE_REPL_TOOL_DESCRIPTION,
	REPL_TOOL_DESCRIPTION,
	STORE_REPL_TOOL_DESCRIPTION,
} from "../src/prompts/prompts.ts";
import { isStoreInstall } from "../src/update/store-install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));

function fakeBuild() {
	const dir = mkdtempSync(join(tmpdir(), "store-"));
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(dir, "sidepanel.html"), `<script src="sidepanel.js"></script>`);
	writeFileSync(join(dir, "sandbox.html"), `<body>\n    <script src="sandbox.js"></script>\n</body>`);
	for (const f of ["sidepanel.js", "sidepanel.js.map", "debug.html", "debug.js", "debug.js.map"]) {
		writeFileSync(join(dir, f), "x");
	}
	for (const icon of Object.values(manifest.icons)) writeFileSync(join(dir, icon), "png");
	mkdirSync(join(dir, "ort"));
	writeFileSync(join(dir, "ort/a.mjs.map"), "x");
	return dir;
}

/** A copy of one fake build `prepare` ran on: packing the libraries takes a second or two, so it runs once. */
let preparedOnce;
function prepared() {
	if (!preparedOnce) {
		preparedOnce = fakeBuild();
		prepare(preparedOnce, root);
	}
	const dir = mkdtempSync(join(tmpdir(), "store-prepared-"));
	cpSync(preparedOnce, dir, { recursive: true });
	return dir;
}

test("a raw build is refused: this is the check that protects the zip", () => {
	const found = problems(fakeBuild()).join("\n");
	for (const word of [
		"sidepanel.js.map",
		"debug.html",
		"debug.js",
		"ort/a.mjs.map",
		"manifest has a key",
		"LICENSE is missing",
		"NOTICE is missing",
		"the sandbox content security policy allows script-src https://esm.run/",
		"the sandbox content security policy allows connect-src https://cdn.jsdelivr.net/",
		"manifest.json names the CDN esm.run",
		"sandbox.html has no import map",
		`${NOTICES_FILE} is missing`,
		`${LIBRARY_DIR}/xlsx.js is missing`,
	]) {
		assert.ok(found.includes(word), `${word} should be reported in:\n${found}`);
	}
});

test("a prepared build passes, keeps the app, and names its source and credits", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	assert.deepEqual(problems(dir), []);
	assert.equal(readFileSync(join(dir, "sidepanel.js"), "utf8"), "x");
	const notice = readFileSync(join(dir, "NOTICE"), "utf8");
	assert.match(notice, /^Local Studio browser extension/);
	assert.match(notice, /github\.com\/baney75\/tychicus/);
	assert.match(notice, /Mario Zechner/);
	assert.match(notice, /0xSero/);
});

test("an html page that loads the debug script is refused", () => {
	const dir = prepared();
	writeFileSync(join(dir, "sidepanel.html"), `<script src="debug.js"></script>`);
	assert.match(problems(dir).join(), /sidepanel\.html loads the debug page/);
});

test("only a manifest with update_url counts as a store copy", () => {
	assert.equal(isStoreInstall({ update_url: "https://clients2.google.com/service/update2/crx" }), true);
	assert.equal(isStoreInstall({}), false);
	assert.equal(isStoreInstall({ update_url: "" }), false);
	assert.equal(isStoreInstall(manifest), false, "the manifest we ship declares none, so unpacked copies keep their updater");
});

test("the store description fits and states one purpose", () => {
	assert.ok(manifest.description.length <= 132);
	assert.doesNotMatch(manifest.description, /\band a\b/);
});

test("store/permissions.md has one row per permission the manifest asks for, and no other", () => {
	const doc = readFileSync(join(root, "store/permissions.md"), "utf8");
	const explained = explainedPermissions(doc);
	const asked = askedPermissions(manifest);
	assert.deepEqual([...explained].sort(), [...asked].sort());
	assert.equal(new Set(explained).size, explained.length, "a permission has two rows");
	assert.doesNotMatch(doc, /NOT NEEDED/, "remove the permission or give its reason");
});

/** A source root with this package.json version, permissions.md and library list, for the checks that read them. */
function fakeRoot({ version = manifest.version, doc = readFileSync(join(root, "store/permissions.md"), "utf8") } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "store-root-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
	mkdirSync(join(dir, "store"));
	writeFileSync(join(dir, "store/permissions.md"), doc);
	mkdirSync(join(dir, "src/prompts"), { recursive: true });
	writeFileSync(join(dir, "src/prompts/sandbox-libraries.json"), readFileSync(join(root, "src/prompts/sandbox-libraries.json")));
	return dir;
}

function preparedWith(change) {
	const dir = prepared();
	const path = join(dir, "manifest.json");
	const m = JSON.parse(readFileSync(path, "utf8"));
	change(m);
	writeFileSync(path, JSON.stringify(m));
	return dir;
}

test("the zip's manifest must be named Local Studio", () => {
	assert.match(problems(preparedWith((m) => (m.name = "Polycarp"))).join(), /manifest name is "Polycarp", not "Local Studio"/);
});

test("every icon the manifest names must be in the zip", () => {
	assert.match(problems(preparedWith((m) => (m.icons["128"] = "icon-gone.png"))).join(), /icon icon-gone\.png is missing/);
	assert.match(problems(preparedWith((m) => delete m.icons["128"])).join(), /no 128 px icon/);
});

test("with the source root: the version must be package.json's", () => {
	const dir = preparedWith(() => {});
	assert.deepEqual(problems(dir, fakeRoot()), []);
	assert.match(problems(dir, fakeRoot({ version: "0.0.1" })).join(), /manifest version .* is not package.json's 0\.0\.1/);
});

test("with the source root: a permission with no reason, or a reason with no permission, is refused", () => {
	assert.match(problems(preparedWith((m) => m.permissions.push("history")), fakeRoot()).join(), /permission history has no reason/);
	const extra = `${readFileSync(join(root, "store/permissions.md"), "utf8")}| \`cookies\` | Not asked for. |\n`;
	assert.match(problems(preparedWith(() => {}), fakeRoot({ doc: extra })).join(), /explains cookies, which the manifest does not ask for/);
});

test("the repo's package.json version is the manifest's", () => {
	assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, manifest.version);
});

test("the listing's summary is the manifest description, word for word", () => {
	const listing = readFileSync(join(root, "store/listing.md"), "utf8");
	const summary = /\*\*Summary\*\*[^\n]*\n\n```\n([^\n]+)\n```/.exec(listing)?.[1];
	assert.equal(summary, manifest.description);
});

test("store/ names only Tychicus", () => {
	for (const name of readdirSync(join(root, "store")).filter((n) => n.endsWith(".md"))) {
		const text = readFileSync(join(root, "store", name), "utf8");
		assert.doesNotMatch(text, /Polycarp|Tabkyra/i, `store/${name} names another product`);
		assert.doesNotMatch(text, /[\u2013\u2014]/, `store/${name} has an en or em dash`);
	}
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (path) => {
	const b = readFileSync(path);
	assert.equal(b.toString("latin1", 1, 4), "PNG", `${path} is not a PNG`);
	return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test("the store images are the sizes the dashboard takes", () => {
	const shots = readdirSync(join(root, "store/screenshots")).filter((n) => n.endsWith(".png"));
	assert.ok(shots.length >= 1 && shots.length <= 5, `the store takes 1 to 5 screenshots, not ${shots.length}`);
	for (const name of shots) assert.deepEqual(pngSize(join(root, "store/screenshots", name)), [1280, 800], name);
	assert.deepEqual(pngSize(join(root, "store/promo-small.png")), [440, 280]);
	assert.deepEqual(pngSize(join(root, "store/promo-marquee.png")), [1400, 560]);
	assert.deepEqual(pngSize(join(root, "static/icon-128.png")), [128, 128]);
	const listing = readFileSync(join(root, "store/listing.md"), "utf8");
	for (const name of shots) assert.ok(listing.includes(`store/screenshots/${name}`), `listing.md does not list ${name}`);
});

// The store build loads no code from outside its package (store/listing.md, "Are you using remote code?").

test("the store sandbox policy keeps the release one's rules and drops every remote source", () => {
	const release = manifest.content_security_policy.sandbox;
	assert.ok(remoteSources(release).length > 0, "the release policy allows CDNs, which this test expects to see removed");
	const store = storeSandboxCsp(release);
	assert.deepEqual(remoteSources(store), []);
	for (const host of CDN_HOSTS) assert.ok(!store.includes(host), `${host} is still in ${store}`);
	assert.match(store, /^sandbox allow-scripts allow-modals; default-src 'none'; /);
	assert.match(store, /script-src 'self' 'unsafe-inline' 'unsafe-eval';/, "the REPL still runs the agent's code");
	assert.match(store, /img-src 'self' data: blob: https:;/, "images from the web still show; they are not code");
	assert.doesNotMatch(store, /connect-src/, "connect-src held only CDNs, so it falls back to default-src 'none'");
});

test("a remote source put back into the store manifest is refused, in any directive but img-src", () => {
	for (const [directive, source] of [
		["script-src", "https://esm.sh/"],
		["script-src-elem", "https://unpkg.com/"],
		["connect-src", "https://example.com"],
		["style-src", "https:"],
		["font-src", "https://fonts.gstatic.com/"],
		["worker-src", "*"],
	]) {
		const dir = preparedWith((m) => {
			m.content_security_policy.sandbox += `; ${directive} 'self' ${source}`;
		});
		assert.match(problems(dir).join("\n"), new RegExp(`sandbox content security policy allows ${directive} ${source.replace(/[*.]/g, "\\$&")}`));
	}
	const pages = preparedWith((m) => {
		m.content_security_policy.extension_pages = "script-src 'self' https://cdn.example.com; object-src 'self'";
	});
	assert.match(problems(pages).join(), /extension_pages content security policy allows script-src https:\/\/cdn\.example\.com/);
	const images = preparedWith((m) => {
		m.content_security_policy.sandbox += "; img-src 'self' https:";
	});
	assert.deepEqual(problems(images), []);
});

test("a file in the store zip that names a CDN is refused", () => {
	const dir = prepared();
	writeFileSync(join(dir, "sidepanel.js"), "const X = await import('https://esm.run/xlsx');");
	assert.match(problems(dir).join(), /sidepanel\.js names the CDN esm\.run/);
});

test("prepare packs every library the store prompt names, maps it by name, and credits it", () => {
	const dir = fakeBuild();
	prepare(dir, root);
	const { modules, scripts } = sandboxLibraries(root);
	for (const lib of [...modules, ...scripts]) {
		const code = readFileSync(join(dir, LIBRARY_DIR, lib.file), "utf8");
		assert.ok(code.length > 500, `${lib.file} is empty`);
	}
	const sandbox = readFileSync(join(dir, "sandbox.html"), "utf8");
	const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(sandbox)[1]);
	assert.deepEqual(map, importMap(root));
	assert.ok(sandbox.indexOf("importmap") < sandbox.indexOf('src="sandbox.js"'), "the map must come before any script");
	for (const m of modules) assert.equal(map.imports[m.specifier], `/${LIBRARY_DIR}/${m.file}`);
	const notices = readFileSync(join(dir, NOTICES_FILE), "utf8");
	for (const lib of [...modules, ...scripts]) assert.ok(notices.includes(`${lib.package} ${lib.version} (`), `${lib.package} ${lib.version} is not credited`);
	// docx's own bundle inlines these; the metafile can't see them.
	for (const name of ["fflate", "nanoid"]) assert.match(notices, new RegExp(`^${name} \\S+ \\(MIT\\)`, "m"));
	rmSync(join(dir, LIBRARY_DIR, "chart-auto.js"));
	assert.match(problems(dir).join(), /sandbox-lib\/chart-auto\.js is missing/);
});

test("the pinned library versions are the installed ones", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const pinned = { ...pkg.dependencies, ...pkg.devDependencies };
	const { modules, scripts } = sandboxLibraries(root);
	for (const lib of [...modules, ...scripts]) {
		const installed = JSON.parse(readFileSync(join(root, "node_modules", lib.package, "package.json"), "utf8")).version;
		assert.equal(installed, lib.version, `${lib.package}: src/prompts/sandbox-libraries.json pins ${lib.version}`);
		assert.ok(pinned[lib.package], `${lib.package} is not in package.json`);
	}
});

test("the store REPL prompt names only the packed libraries and never a CDN", () => {
	const store = STORE_REPL_TOOL_DESCRIPTION([]);
	for (const host of CDN_HOSTS) assert.ok(!store.includes(host), `the store prompt names ${host}`);
	assert.doesNotMatch(store, /any npm package|import\(\s*['"`]https?:/i);
	for (const m of sandboxLibraries(root).modules) assert.ok(store.includes(m.use), `the store prompt does not show ${m.use}`);
	assert.match(store, /Nothing loads from outside the extension/);
});

test("the release REPL prompt is unchanged, and it is the one a build without the store flag uses", () => {
	const release = RELEASE_REPL_TOOL_DESCRIPTION(["RUNTIME"]);
	assert.equal(REPL_TOOL_DESCRIPTION, RELEASE_REPL_TOOL_DESCRIPTION);
	assert.ok(release.includes("- All browser APIs: DOM, Canvas, WebGL, Fetch, Web Workers, WebSockets, Crypto, etc.\n- Import any npm package: await import('https://esm.run/package-name')\n- Clean sandbox"));
	assert.ok(release.includes("## Common Libraries\n- XLSX: const XLSX = await import('https://esm.run/xlsx');"));
	assert.ok(release.includes("- Word: const docx = await import('https://esm.run/docx');\n\n## Input"));
	assert.ok(release.endsWith("\n\nRUNTIME"));
});

test("the store copy of pi-web-ui's prompts names the packed libraries and no CDN", () => {
	const path = join(root, "vendor/pi-mono/packages/web-ui/src/prompts/prompts.ts");
	const source = readFileSync(path, "utf8");
	assert.ok(CDN_HOSTS.some((h) => source.includes(h)), "pi-web-ui's prompts name CDNs; this test expects to see them rewritten");
	const store = storeVendorPrompts(source, sandboxLibraries(root));
	for (const host of CDN_HOSTS) assert.ok(!store.includes(host), `the store copy still names ${host}`);
	assert.match(store, /<script src="\/sandbox-lib\/tailwind\.js"><\/script>/);
	assert.match(store, /await import\('xlsx'\)/);
	assert.match(store, /Tailwind CSS v4[^\n]*There is no tailwind\.config[^\n]*@theme/);
	assert.match(store, /runs only inside this extension/);
	assert.throws(() => storeVendorPrompts(source.replace("Use Tailwind CDN", "Use the Tailwind CDN"), sandboxLibraries(root)), /no longer say/);
	assert.throws(
		() => storeVendorPrompts(`${source}\nconst x = "await import('https://esm.run/lodash')";`, sandboxLibraries(root)),
		/lodash, which the store build does not pack/,
	);
});
