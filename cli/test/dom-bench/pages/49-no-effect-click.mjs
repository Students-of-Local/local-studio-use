export default {
	id: "no-effect-click",
	title: "A click that changes nothing says so (effect, D50)",
	html: `<!doctype html><meta charset="utf-8"><title>Terms</title>
<style>body{font:16px system-ui;margin:24px}</style>
<h1>Terms</h1>
<label><input type="checkbox" id="agree"> I agree to the terms</label>
<p><button type="button" id="go">Continue</button></p>
<p id="msg"></p>
<script>
window.__state = { continued: false };
// Continue looks live but does nothing until the box is ticked: no message, no style, nothing.
document.getElementById("go").onclick = () => {
	if (!document.getElementById("agree").checked) return;
	window.__state.continued = true;
	document.getElementById("msg").textContent = "Thanks, you're in.";
};
</script>`,
	task: "Press Continue; when it does nothing, tick the box and press it again.",
	async solve(t) {
		const go = (await t.find("Continue button")).find((n) => n.role === "button");
		const first = JSON.parse(await t.tool("click", { ref: go.ref }));
		if (JSON.stringify(first.effect) !== '["nothing"]') throw new Error(`a click that changed nothing says ${JSON.stringify(first.effect)}`);
		const box = (await t.find("I agree checkbox")).find((n) => n.role === "checkbox");
		const ticked = JSON.parse(await t.tool("click", { ref: box.ref }));
		if (!ticked.effect?.includes("value")) throw new Error(`ticking a box says ${JSON.stringify(ticked.effect)}`);
		const second = JSON.parse(await t.tool("click", { ref: go.ref }));
		if (!second.effect?.includes("dom")) throw new Error(`a click that showed a message says ${JSON.stringify(second.effect)}`);
	},
	check: async (page) => (await page.eval("window.__state.continued")) === true,
};
