// The Chrome Web Store build's sandbox, in a real Chromium: the agent's code imports the libraries the store prompt names
// and they work with every host but loopback unresolvable, so nothing can come from a CDN. scripts/build-store.sh builds
// the zip from this checkout; the harness loads it unpacked. The page is driven as the REPL drives it: sandbox.html gets
// a `sandbox-load` message with a whole document (head runtime, user code in a module script), which sandbox.js writes
// over itself. That also proves sandbox.html's import map outlives document.write.
//
// Needs `npm run build` in cli/ and a Playwright Chromium (`npx playwright-core install chromium`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cdp, startHarness, until } from "./e2e-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let work;
let h;
let hostUrl;
let browserWs;

before(async () => {
	work = mkdtempSync(join(tmpdir(), "local-studio-store-e2e-"));
	execFileSync("bash", [join(root, "scripts/build-store.sh"), join(work, "zip")], {
		cwd: root,
		env: { ...process.env, LOCAL_STUDIO_BROWSER_NO_BUMP: "1" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	const zip = readdirSync(join(work, "zip")).find((n) => n.endsWith("-store.zip"));
	execFileSync("unzip", ["-q", join(work, "zip", zip), "-d", join(work, "ext")]);
	h = await startHarness({
		name: "store-sandbox",
		extension: join(work, "ext"),
		// Every name but loopback fails to resolve: a library that came from a CDN could not load.
		chromiumArgs: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
	});
	// The store zip has no `key`, so its id is not the release one: find its service worker, the one whose manifest is
	// this build's (Chromium runs other extensions' background.js too).
	const worker = await until(
		async () => {
			for (const t of await h.targets()) {
				if (t.type !== "service_worker" || !t.url.endsWith("/background.js")) continue;
				const r = await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", {
					expression: "JSON.stringify(chrome.runtime.getManifest())",
					returnByValue: true,
				});
				const m = JSON.parse(r.result?.value ?? "{}");
				if (m.name === "Local Studio" && !("key" in m) && m.sandbox) return t;
			}
		},
		20_000,
		"the store build's service worker",
	);
	hostUrl = worker.url.replace(/background\.js$/, "test.html");
	browserWs = (await (await fetch(`http://${h.devtools}/json/version`)).json()).webSocketDebuggerUrl;
});

after(async () => {
	await h?.stop();
	if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * Load `doc` into sandbox.html the way the panel does (src/sidepanel.ts gives pi-web-ui's SandboxedIframe sandbox.html): an
 * extension page frames it with sandbox="allow-scripts allow-modals", waits for `sandbox-ready`, and posts `sandbox-load`
 * with the whole document, which sandbox.js writes over itself. The document's code posts `{ type: "result", value }`
 * back. The host is test.html, a plain page of the extension; a fresh tab each run, as each REPL run gets a new frame.
 */
async function runInSandbox(doc) {
	const { targetId } = await cdp(browserWs, "Target.createTarget", { url: hostUrl });
	try {
		const target = await until(
			async () => (await h.targets()).find((t) => t.id === targetId && t.url === hostUrl),
			10_000,
			"the extension page that frames the sandbox",
		);
		const evaluate = async (expression) => {
			const r = await cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			return r.result.value;
		};
		await until(() => evaluate("document.readyState === 'complete'"), 10_000, "the host page to load");
		await evaluate(`(() => {
			const frame = document.createElement("iframe");
			frame.sandbox.add("allow-scripts");
			frame.sandbox.add("allow-modals");
			frame.src = "sandbox.html";
			addEventListener("message", (e) => {
				if (e.source !== frame.contentWindow) return;
				if (e.data?.type === "sandbox-ready") frame.contentWindow.postMessage({ type: "sandbox-load", code: ${JSON.stringify(doc)} }, "*");
				else if (e.data?.type === "sandbox-error") window.__result = { error: e.data.error };
				else if (e.data?.type === "result") window.__result = e.data.value;
			});
			document.body.append(frame);
			return true;
		})()`);
		return await until(() => evaluate("window.__result"), 30_000, "the sandbox's code to finish");
	} finally {
		await cdp(browserWs, "Target.closeTarget", { targetId }).catch(() => {});
	}
}

/** A REPL document: a classic runtime script in the head and the user's code in a module script, as pi-web-ui writes it. */
const replDocument = (code) => `<!DOCTYPE html>
<html>
<head>
	<script>window.__runtime = true;</script>
</head>
<body>
	<script type="module">
		(async () => {
			try {
				parent.postMessage({ type: "result", value: await (async () => { ${code} })() }, "*");
			} catch (error) {
				parent.postMessage({ type: "result", value: { error: String(error && error.message || error) } }, "*");
			}
		})();
	</script>
</body>
</html>`;

test("the store sandbox imports xlsx and chart.js from the package, with CDNs unreachable", { timeout: 120_000 }, async () => {
	const result = await runInSandbox(
		replDocument(`
			const XLSX = await import('xlsx');
			const book = XLSX.utils.book_new();
			XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["name", "n"], ["a", 1], ["b", 2]]), "S");
			const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
			const rows = XLSX.utils.sheet_to_json(XLSX.read(bytes).Sheets.S);

			const Chart = (await import('chart.js/auto')).default;
			const canvas = document.createElement("canvas");
			canvas.width = 200;
			canvas.height = 100;
			document.body.append(canvas);
			const chart = new Chart(canvas, { type: "bar", data: { labels: ["a", "b"], datasets: [{ data: [1, 2] }] }, options: { animation: false, responsive: false } });
			const pixels = canvas.getContext("2d").getImageData(0, 0, 200, 100).data;
			let painted = 0;
			for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;

			const { Chart: Named } = await import('chart.js');
			return { rows, bars: chart.getDatasetMeta(0).data.length, painted, sameChart: Named === Chart, runtime: window.__runtime === true };
		`),
	);
	assert.equal(result.error, undefined, `the sandbox's code failed: ${result.error}`);
	assert.deepEqual(result.rows, [
		{ name: "a", n: 1 },
		{ name: "b", n: 2 },
	]);
	assert.equal(result.bars, 2);
	assert.ok(result.painted > 100, `the chart drew ${result.painted} pixels`);
	assert.equal(result.sameChart, true, "chart.js and chart.js/auto share one Chart");
	assert.equal(result.runtime, true, "the head runtime ran");
});

test("the other packed libraries import too, and nothing loads from outside the package", { timeout: 120_000 }, async () => {
	const result = await runInSandbox(
		replDocument(`
			const Papa = (await import('papaparse')).default;
			const THREE = await import('three');
			const { PDFDocument } = await import('pdf-lib');
			const docx = await import('docx');
			const pdf = await PDFDocument.create();
			pdf.addPage();
			const remote = {};
			for (const url of ["https://esm.run/xlsx", "https://esm.sh/papaparse", "https://cdn.jsdelivr.net/npm/three/+esm"]) {
				try {
					await import(url);
					remote[url] = "loaded";
				} catch {
					remote[url] = "refused";
				}
			}
			let unlisted;
			try {
				await import('lodash');
				unlisted = "loaded";
			} catch {
				unlisted = "refused";
			}
			return {
				csv: Papa.parse("a,b\\n1,2", { header: true }).data,
				vector: new THREE.Vector3(1, 2, 2).length(),
				pages: pdf.getPageCount(),
				paragraph: typeof docx.Paragraph,
				remote,
				unlisted,
			};
		`),
	);
	assert.equal(result.error, undefined, `the sandbox's code failed: ${result.error}`);
	assert.deepEqual(result.csv, [{ a: "1", b: "2" }]);
	assert.equal(result.vector, 3);
	assert.equal(result.pages, 1);
	assert.equal(result.paragraph, "function");
	for (const [url, state] of Object.entries(result.remote)) assert.equal(state, "refused", `${url} was ${state}`);
	assert.equal(result.unlisted, "refused", "a package the store build does not pack must not import");
});

test("an HTML artifact styles itself with the packed Tailwind and imports a library statically", { timeout: 120_000 }, async () => {
	const result = await runInSandbox(`<!DOCTYPE html>
<html>
<head>
	<script src="/sandbox-lib/tailwind.js"></script>
</head>
<body>
	<div id="box" class="p-4 hidden"></div>
	<script type="module">
		import * as XLSX from 'xlsx';
		const wait = () => new Promise((r) => setTimeout(r, 50));
		let display = "";
		for (let i = 0; i < 60 && display !== "none"; i++) {
			await wait();
			display = getComputedStyle(document.getElementById("box")).display;
		}
		parent.postMessage({ type: "result", value: { display, padding: getComputedStyle(document.getElementById("box")).paddingTop, xlsx: typeof XLSX.read } }, "*");
	</script>
</body>
</html>`);
	assert.equal(result.display, "none", "Tailwind's `hidden` applied");
	assert.equal(result.padding, "16px", "Tailwind's `p-4` applied");
	assert.equal(result.xlsx, "function");
});
