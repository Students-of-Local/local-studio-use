export default {
	id: "stale-ref-search-cut",
	title: "A stale ref never heals when the look-alike search stopped before seeing every match (D51, review r1)",
	html: `<!doctype html><meta charset="utf-8"><title>Reports</title>
<style>body{font:16px system-ui;margin:24px}li{margin:2px 0}</style>
<h1>Reports</h1>
<button type="button" id="refresh">Refresh</button>
<ul id="list"></ul>
<script>
window.__state = { archived: [] };
const row = (text, tag) => {
	const li = document.createElement("li");
	li.append(text + " ");
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = "Archive";
	b.onclick = () => window.__state.archived.push(tag);
	li.append(b);
	return li;
};
document.getElementById("list").replaceChildren(row("Q3 sales", "q3"));
// The refresh rebuilds the row, then adds 60 more Archive rows and, past them, a second row with the same text.
document.getElementById("refresh").onclick = () => {
	const rows = [row("Q3 sales", "q3-a")];
	for (let i = 0; i < 60; i++) rows.push(row("Other " + i, "other-" + i));
	rows.push(row("Q3 sales", "q3-b"));
	document.getElementById("list").replaceChildren(...rows);
};
</script>`,
	task: "Click Archive with the ref read before a refresh that made a second Q3 row past the search limit: refused.",
	async solve(t) {
		const before = (await t.read("interactive")).nodes.filter((n) => n.role === "button" && /^archive$/i.test(n.name));
		if (before.length !== 1) throw new Error(`expected 1 Archive button, read ${before.length}`);
		const refresh = (await t.find("Refresh button")).find((n) => /refresh/i.test(n.name));
		await t.tool("click", { ref: refresh.ref });
		const r = await t.try("click", { ref: before[0].ref });
		if (r.ok) throw new Error(`a stale ref healed though the search was cut short: ${r.text.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.archived)")) === "[]",
};
