// End to end: site_filter through a real MCP client, the built extension and its feed filter content script in Chromium.
// A filter hides matching posts in a tab already open and on the next load, new posts as they scroll in, shows a count, and
// comes off with site_edit remove. Then the filter's own code on 2,000 posts in Chromium: every batch under 50 ms.
//
// Needs `npm run build` here and at the repo root (dist-chrome) and a Playwright Chromium, like e2e-bridge.test.mjs.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startHarness } from "./e2e-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let h;
const HOST = "feed.example";

/** Posts `from` to `from + n - 1`, shaped like a feed: author link, time, text. Every tenth is about crypto. */
function posts(from, n) {
	let html = "";
	for (let i = from; i < from + n; i++) {
		html +=
			`<article><header><a href="/@user${i}"><span>User ${i}</span></a> <time>${i}m</time></header>` +
			`<div><p>Post ${i}: ${i % 10 === 0 ? "what crypto prices did today" : "a walk in the park with the dog"}</p>` +
			`<div><button>Like</button><button>Reply</button></div></div></article>`;
	}
	return html;
}

const FEED = `<!doctype html><title>Feed</title><main><h1>Feed</h1><div id="feed">${posts(0, 200)}</div></main>
<script>window.more = (from, n) => { const t = document.createElement("template"); t.innerHTML = (${posts.toString()})(from, n); document.getElementById("feed").append(t.content); };</script>`;

before(async () => {
	// 127.0.0.1 is a host agents never edit, so the feed is served under a name of its own.
	h = await startHarness({ name: "feed-filter", chromiumArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
});
after(async () => {
	await h?.stop();
});

const hiddenCount = (url) => h.evaluate(`document.querySelectorAll("article.tk-feed-hidden").length`, url);
const badgeText = (url) => h.evaluate(`document.querySelector("[data-tychicus=feed-filter]")?.shadowRoot?.textContent ?? ""`, url);

test("site_filter hides matching posts in the open tab, new ones as they scroll in and after a reload; site_edit lists and removes it", async () => {
	const url = h.mount("feed", FEED).replace("127.0.0.1", HOST);
	await h.go(url);
	assert.equal(await hiddenCount(url), 0);

	const added = JSON.parse(await h.tool("site_filter", { host: HOST, words: ["crypto"], handles: ["@user7"], note: "e2e" }));
	assert.equal(added.edit.kind, "filter");
	assert.equal(added.edit.on, true);
	// 20 posts about crypto (0, 10, ..., 190) and user7's.
	await h.until(async () => (await hiddenCount(url)) === 21, 15_000, "the open tab to hide 21 posts");
	assert.equal(await h.evaluate(`getComputedStyle(document.querySelector("article.tk-feed-hidden")).display`, url), "none");
	assert.equal(await h.evaluate(`document.querySelectorAll("article").length`, url), 200, "hidden, never removed");
	await h.until(async () => /21 hidden by your filter/.test(await badgeText(url)), 5_000, "the count");
	// What an agent reads leaves them out too.
	const text = await h.tool("get_page_text");
	assert.ok(!text.includes("crypto"), "get_page_text still shows a filtered post");
	assert.ok(text.includes("Post 1:"));

	// Infinite scroll: 100 more posts, 10 about crypto.
	await h.evaluate("more(200, 100)", url);
	await h.until(async () => (await hiddenCount(url)) === 31, 10_000, "new posts to be filtered");
	await h.until(async () => /31 hidden/.test(await badgeText(url)), 5_000, "the count to follow");

	// A fresh load: the registered content script, at document start.
	await h.tool("navigate", { url: `${url}?again` });
	await h.until(async () => (await hiddenCount(`${url}?again`)) === 21, 15_000, "the reloaded page to hide 21 posts");

	const listed = JSON.parse(await h.tool("site_edit", { action: "list", host: HOST }));
	const filter = listed.edits.find((e) => e.kind === "filter");
	assert.deepEqual(filter.filter, { words: ["crypto"], handles: ["user7"] }, "listed as words and handles, not JSON");

	const bad = await h.call("site_filter", { host: HOST, words: ["/(a+)+$/"] });
	assert.ok(!bad.ok && /freeze/.test(bad.text), bad.text);

	await h.tool("site_edit", { action: "remove", id: filter.id });
	await h.until(async () => (await hiddenCount(`${url}?again`)) === 0, 10_000, "the posts to come back");
	await h.until(async () => (await badgeText(`${url}?again`)) === "", 5_000, "the count to go");
});

test("2,000 posts in Chromium: the first pass, a 2,000-post scroll batch and a full recheck each take under 50 ms", async () => {
	const bundle = await build({
		entryPoints: [join(here, "..", "..", "src", "site-edits", "feed-filter-core.ts")],
		bundle: true,
		write: false,
		format: "iife",
		globalName: "TkFeedFilter",
		target: "chrome120",
	});
	const url = h.mount("perf", {
		"/": `<!doctype html><title>Perf</title><main><div id="feed">${posts(0, 2000)}</div></main><script src="{{base}}/core.js"></script>
<script>
window.measure = () => {
	const f = TkFeedFilter.startFeedFilter(document, [{ words: ["crypto", "/airdrops?/", "machine learning"], handles: ["@user7", "@user99"] }], { hostname: location.hostname });
	const first = f.stats();
	const t = document.createElement("template");
	t.innerHTML = (${posts.toString()})(2000, 2000);
	document.getElementById("feed").append(t.content);
	f.flush();
	const scroll = f.stats();
	f.update([{ words: ["park"], handles: [] }]);
	const recheck = f.stats();
	return { first, scroll, recheck, articles: document.querySelectorAll("article").length };
};
</script>`,
		"/core.js": bundle.outputFiles[0].text,
	});
	await h.go(url);
	const r = await h.evaluate("measure()", url);
	console.log(`feed filter batches: first ${r.first.lastBatchMs.toFixed(1)} ms (${r.first.lastBatchItems} posts), scroll ${r.scroll.lastBatchMs.toFixed(1)} ms (${r.scroll.lastBatchItems}), recheck ${r.recheck.lastBatchMs.toFixed(1)} ms (${r.recheck.lastBatchItems})`);
	assert.equal(r.articles, 4000);
	assert.equal(r.first.lastBatchItems, 2000);
	assert.equal(r.first.hidden, 202, "200 about crypto, user7 and user99");
	assert.equal(r.scroll.lastBatchItems, 2000);
	assert.equal(r.scroll.hidden, 402);
	assert.equal(r.recheck.hidden, 3600, "every post but the ones about crypto mentions the park");
	for (const [name, s] of Object.entries({ first: r.first, scroll: r.scroll, recheck: r.recheck }))
		assert.ok(s.lastBatchMs < 50, `${name} batch took ${s.lastBatchMs} ms`);
});
