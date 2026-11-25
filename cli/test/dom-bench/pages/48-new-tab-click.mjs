export default {
	id: "new-tab-click",
	title: "A link that opens a new tab: the click result names it (newTabs)",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Shop</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Checkout</h1>
<p>Questions? <a href="help.html" target="_blank">Shipping help</a></p>
<script>localStorage.removeItem("ack")</script>`,
		"/help.html": `<!doctype html><meta charset="utf-8"><title>Shipping help</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Shipping help</h1><p>We ship in 2 days.</p>
<button type="button" onclick="localStorage.setItem('ack','yes');this.textContent='Thanks'">Got it</button>`,
	},
	task: "Open Shipping help, press Got it there, and close that tab.",
	async solve(t) {
		const link = (await t.find("Shipping help link")).find((n) => n.role === "link");
		const r = JSON.parse(await t.tool("click", { ref: link.ref }));
		// The result lists the tab, with no tabs_context call to find it.
		const tab = r.newTabs?.find((x) => /help\.html/.test(x.url ?? ""));
		if (!tab) throw new Error(`the click result names no new tab: ${JSON.stringify(r).slice(0, 300)}`);
		if (!r.effect?.includes("newTab")) throw new Error(`effect does not say newTab: ${JSON.stringify(r.effect)}`);
		await t.tool("tabs_select", { tabId: tab.tabId });
		const ok = (await t.find("Got it button")).find((n) => n.role === "button");
		await t.tool("click", { ref: ok.ref });
		await t.tool("tabs_close", { tabId: tab.tabId });
	},
	check: async (page) => (await page.eval('localStorage.getItem("ack")')) === "yes",
};
