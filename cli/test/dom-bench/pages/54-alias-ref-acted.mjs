export default {
	id: "alias-ref-acted",
	title: "Two refs for one control: an action through one stops the other healing onto a look-alike (D51, review r2)",
	html: `<!doctype html><meta charset="utf-8"><title>Reports</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Reports</h1>
<button type="button" id="refresh">Refresh</button>
<ul id="list"></ul>
<script>
window.__state = { archived: 0 };
function render() {
	const li = document.createElement("li");
	li.append("Q3 sales ");
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = "Archive";
	// Archiving re-renders the list, and the same row comes back (a list that refreshes from the server).
	b.onclick = () => { window.__state.archived++; setTimeout(render, 0); };
	li.append(b);
	document.getElementById("list").replaceChildren(li);
}
document.getElementById("refresh").onclick = render;
render();
</script>`,
	task: "Archive once through the old ref; the fresh ref the change report gave for the same button must not act again.",
	async solve(t) {
		const a = (await t.read("interactive")).nodes.find((n) => n.role === "button" && /^archive$/i.test(n.name));
		if (!a) throw new Error("no Archive button read");
		const refresh = (await t.find("Refresh button")).find((n) => /refresh/i.test(n.name));
		const report = await t.tool("click", { ref: refresh.ref });
		const b = [...report.matchAll(/\b(e\d+) button \\?"Archive\\?"/g)].map((m) => m[1]).find((r) => r !== a.ref);
		if (!b) throw new Error(`the change report gave no fresh ref for the rebuilt Archive button: ${report.slice(0, 400)}`);
		await t.tool("click", { ref: a.ref });
		await new Promise((r) => setTimeout(r, 300));
		const again = await t.try("click", { ref: b });
		if (again.ok) throw new Error(`the other ref for the same button acted again: ${again.text.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("window.__state.archived")) === 1,
};
