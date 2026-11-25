// The scripted solves, written once against the driver verbs (lib/drivers.mjs). A solve finds every target by role and
// accessible name in the tool's own snapshot, so a tool that hides an element (frame, shadow root) fails here honestly.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const re = (x) => (x instanceof RegExp ? x : new RegExp(`^\\s*${String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"));

/** One node by role (regex) and name (regex or exact string, case-insensitive). `after` = only nodes after that index. */
function pick(nodes, role, name, { after = -1, nth = 0 } = {}) {
	const anchor = /heading/i.test(String(role));
	const hits = nodes.map((n, i) => ({ ...n, i })).filter((n) => n.i > after && (anchor || n.ref) && re(role).test(n.role) && re(name).test(n.name));
	if (hits.length <= nth) throw new Error(`no ${role} named ${name} in the snapshot (${nodes.length} nodes)`);
	return hits[nth];
}
/** Snapshot or page text as one line, without outline markup, so a fact split over cells or a <code> reads as prose. */
const flat = (t) => String(t).replace(/\[ref=[^\]]*\]|\[level=\d\]/g, " ").replace(/\n\s*-\s*(?:[a-z]+(?: "|:)?)?/gi, " ").replace(/["`]/g, " ").replace(/\s+/g, " ");
const TEXTBOX = /^(textbox|searchbox|input|text|combobox|spinbutton)$/i;

export const solves = {
	async "t01-read"(d) {
		const text = flat(await d.text());
		const m = /\bK7\b(?! Lite).{0,60}?\b(\d{4})\b/.exec(text);
		return m?.[1] ?? "";
	},
	async "t02-form"(d) {
		const n = await d.nodes();
		await d.fill(pick(n, TEXTBOX, "Full name"), "Ada Lovelace");
		await d.fill(pick(n, TEXTBOX, /^email/i), "ada@example.test");
		await d.select(pick(n, /combobox|listbox|select/i, /plan|choose one/i), "Team");
		await d.check(pick(n, /radio/i, "Phone"));
		await d.check(pick(n, /checkbox/i, /newsletter/i));
		await d.click(pick(n, /button/i, "Create account"));
	},
	async "t03-multitab"(d) {
		const n = await d.nodes();
		await d.clickNewTab(pick(n, /link/i, /open voucher/i));
		const text = await d.text();
		const code = /VX-[0-9A-F]{4}/.exec(text)?.[0];
		if (!code) throw new Error("voucher code not in the new tab's text");
		await d.backToFirst();
		const m = await d.nodes();
		await d.fill(pick(m, TEXTBOX, "Voucher code"), code);
		await d.click(pick(m, /button/i, "Redeem"));
	},
	async "t04-checkout"(d) {
		let n = await d.nodes();
		const add = (product) => pick(n, /button/i, "Add to cart", { after: pick(n, /heading/i, product).i });
		await d.click(add("Blue Mug"));
		await d.click(add("Blue Mug"));
		await d.click(add("Tea Tin"));
		n = await d.nodes();
		await d.click(pick(n, /link/i, /^cart \(3\)$/i));
		n = await d.nodes();
		await d.click(pick(n, /button/i, "Proceed to checkout"));
		n = await d.nodes();
		await d.fill(pick(n, TEXTBOX, "Name"), "Grace Hopper");
		await d.fill(pick(n, TEXTBOX, "Street address"), "1 Navy Way");
		await d.fill(pick(n, TEXTBOX, "ZIP code"), "20001");
		await d.check(pick(n, /radio/i, /^express/i));
		await d.click(pick(n, /button/i, "Place order"));
	},
	async "t05-iframe"(d) {
		const n = await d.nodes();
		await d.fill(pick(n, TEXTBOX, "Card holder"), "Alan Turing");
		await d.click(pick(n, /button/i, "Confirm payment"));
	},
	async "t06-shadow"(d) {
		const n = await d.nodes();
		await d.fill(pick(n, TEXTBOX, "Display name"), "Kestrel");
		await d.click(pick(n, /button/i, "Save name"));
	},
	async "t07-upload"(d, { fixtures }) {
		const n = await d.nodes();
		await d.upload(pick(n, /button|textbox|input|file/i, "Attach receipt"), `${fixtures}/receipt.txt`);
		await d.click(pick(n, /button/i, "Submit claim"));
	},
	// Stale element: refs read before the list re-renders, then used after. A tool passes if it refuses the stale ref
	// (and the solve re-reads) or still hits the right row; it fails if it clicks the wrong row silently.
	async "t08-stale"(d) {
		const n = await d.nodes();
		const stale = pick(n, /button/i, "Approve invoice 3307");
		await d.click(pick(n, /button/i, "Refresh list"));
		await sleep(900);
		let r;
		try {
			r = await d.click(stale);
		} catch (e) {
			r = `stale: ${e.message}`;
		}
		if (/stale|not found|detached|no longer|expired|unknown ref|not attached|could not|no element|failed/i.test(String(r))) {
			d.s.recovered = true;
			const m = await d.nodes();
			await d.click(pick(m, /button/i, "Approve invoice 3307"));
		}
	},
	async "t09-long"(d) {
		const P = /access phrase is\W*(?:code\W*)?([a-z]+-[a-z]+-\d+)/i;
		let phrase = P.exec(flat(await d.text()))?.[1];
		if (!phrase) phrase = P.exec(flat(await d.search("access phrase is")))?.[1];
		if (!phrase) throw new Error("phrase not found in page text or search");
		const n = await d.nodes();
		await d.fill(pick(n, TEXTBOX, "Access phrase"), phrase);
		await d.click(pick(n, /button/i, "Unlock"));
	},
	async "t10-dialog"(d) {
		const n = await d.nodes();
		await d.click(pick(n, /button/i, "Delete draft"));
		await d.dialog(true);
		await sleep(300);
		await d.dialog(true, "DELETE");
	},
};
