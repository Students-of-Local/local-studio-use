export default {
	id: "name-partial-refused",
	title: "A name that only partly matches one control is refused, not acted on (D52, review r1)",
	html: `<!doctype html><meta charset="utf-8"><title>Account</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Delete</h1>
<p>Settings for your account.</p>
<button type="button" id="del">Delete account</button>
<script>
window.__state = { deleted: false };
document.getElementById("del").onclick = () => { window.__state.deleted = true; };
</script>`,
	task: "Send the name Delete, which no control has exactly: it must be refused and the near match named.",
	async solve(t) {
		const r = await t.try("click", { ref: "Delete" });
		if (r.ok) throw new Error(`a partial name was acted on: ${r.text.slice(0, 300)}`);
		if (!/button "Delete account"/.test(r.text)) throw new Error(`the refusal does not name the near match: ${r.text.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("String(window.__state.deleted)")) === "false",
};
