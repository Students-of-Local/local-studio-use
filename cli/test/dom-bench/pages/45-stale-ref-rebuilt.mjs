export default {
	id: "stale-ref-rebuilt",
	title: "A list the app rebuilds after every click (stale ref, D51)",
	html: `<!doctype html><meta charset="utf-8"><title>Chores</title>
<style>body{font:16px system-ui;margin:24px}li{margin:6px 0}</style>
<h1>Chores</h1>
<ul id="list"></ul>
<script>
window.__state = { done: [] };
const chores = ["Buy milk", "Walk the dog", "Water plants"];
// Like a framework re-render without keys: every click throws the whole list away and builds it again.
function render() {
	const ul = document.getElementById("list");
	ul.replaceChildren(...chores.map((c) => {
		const li = document.createElement("li");
		const done = window.__state.done.includes(c);
		li.append(c + " ");
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = "Done";
		b.disabled = done;
		b.onclick = () => { window.__state.done.push(c); render(); };
		li.append(b);
		return li;
	}));
}
render();
</script>`,
	task: "Mark Buy milk and Walk the dog done, using the refs from one read of the page.",
	async solve(t) {
		// One read, then both clicks: the second ref went stale when the first click rebuilt the list. The ref must be found
		// again by its role, name and row, not refused and not moved to another row.
		const snap = await t.read("interactive");
		const all = snap.nodes.filter((n) => n.role === "button" && /^done$/i.test(n.name));
		if (all.length !== 3) throw new Error(`expected 3 Done buttons, read ${all.length}: ${snap.raw.slice(0, 400)}`);
		const [milk, dog] = all;
		await t.tool("click", { ref: milk.ref });
		const r = await t.tool("click", { ref: dog.ref });
		if (!/refound/.test(r)) throw new Error(`the stale ref worked without saying it was found again: ${r.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.done)")) === '["Buy milk","Walk the dog"]',
};
