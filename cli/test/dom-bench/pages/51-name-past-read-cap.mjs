export default {
	id: "name-past-read-cap",
	title: "A name lookup on a page bigger than one read is refused: a twin may sit past the cap (D52, review r1)",
	html: `<!doctype html><meta charset="utf-8"><title>Files</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Files</h1>
<div id="top"><button type="button" data-a="first">Remove</button></div>
<div id="many"></div>
<div id="end"><button type="button" data-a="last">Remove</button></div>
<script>
window.__state = { did: [] };
const many = document.getElementById("many");
for (let i = 0; i < 700; i++) {
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = "File " + i;
	many.append(b);
}
for (const b of document.querySelectorAll("button[data-a]")) b.onclick = () => window.__state.did.push(b.dataset.a);
</script>`,
	task: "Send the name Remove on a page with 700 other buttons between the two Remove buttons: refused, nothing done.",
	async solve(t) {
		const r = await t.try("click", { ref: "Remove" });
		if (r.ok) throw new Error(`a name was acted on when the read stopped at its cap: ${r.text.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("JSON.stringify(window.__state.did)")) === "[]",
};
