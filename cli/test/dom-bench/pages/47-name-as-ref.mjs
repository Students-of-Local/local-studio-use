export default {
	id: "name-as-ref",
	title: "A control's name sent in place of its ref, as weak models do (D52)",
	html: `<!doctype html><meta charset="utf-8"><title>Post</title>
<style>body{font:16px system-ui;margin:24px}section{margin:12px 0}</style>
<h1>New post</h1>
<label>Title <input id="title"></label>
<section><button type="button" data-a="save">Save draft</button> <button type="button" data-a="publish">Publish</button></section>
<section>Old post 1 <button type="button" data-a="delete-1">Delete</button></section>
<section>Old post 2 <button type="button" data-a="delete-2">Delete</button></section>
<script>
window.__state = { did: [] };
for (const b of document.querySelectorAll("button")) b.onclick = () => window.__state.did.push(b.dataset.a);
</script>`,
	task: "Type a title, save the draft and publish it, naming controls instead of refs. Delete nothing.",
	async solve(t) {
		// No read_page: every target is a name, the way a weak model sends one after losing its refs.
		await t.tool("fill", { ref: "Title", value: "Hello" });
		const saved = await t.tool("click", { button: "Save draft" });
		if (!/lookedUp/.test(saved)) throw new Error(`the result does not say which control the name meant: ${saved.slice(0, 300)}`);
		await t.tool("click", { ref: "the Publish button" });
		// Two controls are named Delete: refused, both named, nothing done.
		const r = await t.try("click", { ref: "Delete" });
		if (r.ok) throw new Error(`an ambiguous name was acted on: ${r.text.slice(0, 300)}`);
		if ((r.text.match(/button "Delete"/g) ?? []).length < 2) throw new Error(`the refusal does not name both Delete buttons: ${r.text.slice(0, 400)}`);
		// mouseButton is the mouse button now; button "left" still means the mouse button, not a control named left.
		const m = await t.try("click", { ref: "Publish", button: "left" });
		if (!m.ok) throw new Error(`button "left" with a ref was not read as the mouse button: ${m.text.slice(0, 300)}`);
	},
	check: async (page) =>
		(await page.eval('JSON.stringify([document.getElementById("title").value, window.__state.did])')) === '["Hello",["save","publish","publish"]]',
};
