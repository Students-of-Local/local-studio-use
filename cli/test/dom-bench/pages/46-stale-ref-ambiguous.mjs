export default {
	id: "stale-ref-ambiguous",
	title: "A stale ref whose row changed: refused, with the candidates named (D51)",
	html: `<!doctype html><meta charset="utf-8"><title>Reports</title>
<style>body{font:16px system-ui;margin:24px}li{margin:6px 0}</style>
<h1>Reports</h1>
<button type="button" id="refresh">Refresh</button>
<ul id="list"></ul>
<script>
window.__state = { archived: [], ticks: 0 };
const reports = ["Q1 sales", "Q2 sales", "Q3 sales"];
// Every refresh builds new rows, and each row shows how long ago it was checked, so no row's text stays the same.
function render() {
	window.__state.ticks++;
	document.getElementById("list").replaceChildren(...reports.map((r) => {
		const li = document.createElement("li");
		li.append(r + " (checked " + window.__state.ticks + " min ago) ");
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = "Archive";
		b.onclick = () => window.__state.archived.push(r);
		li.append(b);
		return li;
	}));
}
document.getElementById("refresh").onclick = render;
render();
</script>`,
	task: "Archive Q3 sales after a refresh, using the ref read before the refresh first.",
	async solve(t) {
		const before = (await t.read("interactive")).nodes.filter((n) => n.role === "button" && /^archive$/i.test(n.name));
		if (before.length !== 3) throw new Error(`expected 3 Archive buttons, read ${before.length}`);
		const q3 = before[2];
		const refresh = (await t.find("Refresh button")).find((n) => /refresh/i.test(n.name));
		await t.tool("click", { ref: refresh.ref });
		// Every row's text changed, so no Archive button is provably the one read: the click must be refused, nothing done,
		// and the refusal must name the Archive buttons with their rows so the agent can pick without reading again.
		const r = await t.try("click", { ref: q3.ref });
		if (r.ok) throw new Error(`a stale ref whose row changed was acted on: ${r.text.slice(0, 300)}`);
		const named = [...r.text.matchAll(/\b(e\d+) in "([^"]*)"/g)].map((m) => ({ ref: m[1], row: m[2] }));
		if (named.length < 3) throw new Error(`the refusal does not name the 3 Archive buttons: ${r.text.slice(0, 400)}`);
		const pick = named.find((n) => /Q3 sales/.test(n.row));
		if (!pick) throw new Error(`no candidate in the Q3 row: ${r.text.slice(0, 400)}`);
		await t.tool("click", { ref: pick.ref });
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.archived)")) === '["Q3 sales"]',
};
