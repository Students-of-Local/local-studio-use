export default {
	id: "frame-late-reaction",
	title: "A click in a cross-origin frame that reacts late never reports nothing happened (D50, review r2)",
	html: {
		"/": `<!doctype html><meta charset="utf-8"><title>Store</title>
<style>body{font:16px system-ui;margin:24px}iframe{border:1px solid #888;width:360px;height:140px}</style>
<h1>Checkout</h1><iframe src="{{origin2}}{{base}}/pay" title="Payment"></iframe>
<script>window.__state = { paid: 0 }; addEventListener("message", (e) => { if (e.data === "paid") window.__state.paid++; });</script>`,
		"/pay": `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><p id="s">Total: $48.00</p><button type="button" id="b">Confirm payment</button>
<script>document.getElementById("b").onclick = () => setTimeout(() => { document.getElementById("s").textContent = "Paid"; parent.postMessage("paid", "*"); }, 400);</script>`,
	},
	task: "Confirm the payment once; the frame answers after 400 ms.",
	async solve(t) {
		const hit = (await t.find("Confirm payment button")).find((n) => /confirm payment/i.test(n.name));
		if (!hit) throw new Error("no Confirm payment button found");
		const out = await t.tool("click", { ref: hit.ref });
		if (/"effect":\["nothing"\]/.test(out)) throw new Error(`a frame click that reacts late said nothing happened: ${out.slice(0, 300)}`);
	},
	check: async (page) => (await page.eval("window.__state.paid")) === 1,
};
