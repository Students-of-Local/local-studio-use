// What goes out, and where it lands: a click's pointer move is sent ahead of its press, and a scroll on a ref moves the
// nearest box that scrolls along the axis asked for (first-F1 and second-S1 of the #261 review).
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const { click } = await import("../src/browser/cdp.ts");
const { scrollPage } = await import("../src/browser/page.ts");

const pointer = [];
let page;
chrome.debugger.sendCommand = async (_target, method, params) => {
	if (method === "Input.dispatchMouseEvent") pointer.push(params.type);
	return method === "Runtime.evaluate" ? { result: { value: await vm.runInContext(params.expression, page) } } : {};
};

for (const [name, active, clicks] of [
	["the tab the person looks at", true, 1],
	["a hidden tab", false, 1],
	["a double click", false, 2],
])
	test(`a click sends its move before its press, attached or not: ${name}`, async () => {
		const tabId = fake.addTab({ url: "https://shop.example/", active });
		const press = Array.from({ length: clicks }, () => ["mousePressed", "mouseReleased"]).flat();
		for (const round of ["first use of the tab", "attached already"]) {
			pointer.length = 0;
			await click(tabId, 10, 10, { clickCount: clicks });
			assert.deepEqual(pointer, ["mouseMoved", ...press], round);
		}
		pointer.length = 0;
		await click(tabId, 10, 10, { clickCount: clicks, pointerThere: true });
		assert.deepEqual(pointer, press, "the pointer is there already");
	});

/** A box of one size holding content of another, inside `parentElement`. */
const box = (parentElement, overflowX, overflowY, [clientWidth, clientHeight], [scrollWidth, scrollHeight]) => {
	const at = (axis, o, by, most) => Math.max(0, Math.min(most, by * axis + (o ?? axis * (1 - by))));
	const el = { parentElement, overflowX, overflowY, clientWidth, clientHeight, scrollWidth, scrollHeight, scrollLeft: 0, scrollTop: 0 };
	const move = (o, by) => {
		el.scrollLeft = at(el.scrollLeft, o.left, by, scrollWidth - clientWidth);
		el.scrollTop = at(el.scrollTop, o.top, by, scrollHeight - clientHeight);
	};
	return Object.assign(el, { scrollTo: (o) => move(o, 0), scrollBy: (o) => move(o, 1), dispatchEvent() {}, getRootNode: () => ({}) });
};

test("a scroll on an element moves the nearest box that scrolls along the axis asked for", async () => {
	const tabId = fake.addTab({ url: "https://shop.example/", active: true });
	const scene = () => {
		const root = box(null, "visible", "visible", [800, 600], [800, 600]);
		const pane = box(root, "visible", "auto", [800, 600], [800, 3000]);
		const wide = box(pane, "auto", "visible", [400, 200], [2000, 200]);
		const cell = box(wide, "visible", "visible", [100, 20], [100, 20]);
		const win = { scrollX: 0, scrollY: 0, scrollBy: (o) => Object.assign(win, { scrollX: o.left, scrollY: o.top }) };
		page = vm.createContext({
			window: win,
			document: { body: undefined, documentElement: root, querySelector: () => cell },
			ShadowRoot: class {},
			getComputedStyle: (el) => el,
			requestAnimationFrame: (fn) => fn(),
			setTimeout,
			Event,
		});
		return { pane, wide, win };
	};
	const scroll = (o) => scrollPage(tabId, { ref: "e999", selector: "td", ...o });
	let { pane, wide, win } = scene();
	let r = await scroll({ dy: 600 });
	assert.deepEqual([pane.scrollTop, wide.scrollTop, r.scrollTop, r.atEnd], [600, 0, 600, false], "past the sideways table to the pane");
	r = await scroll({ to: "bottom" });
	assert.deepEqual([pane.scrollTop, r.atEnd], [2400, true], "the pane's end, not the table's");
	r = await scroll({ dx: 300 });
	assert.deepEqual([wide.scrollLeft, pane.scrollLeft, r.scrollLeft], [300, 0, 300], "sideways: the table");
	({ pane, wide, win } = scene());
	pane.overflowY = "hidden";
	r = await scroll({ dy: 250 });
	assert.deepEqual([wide.scrollTop, pane.scrollTop, win.scrollY, r.scrolled], [0, 0, 250, undefined], "no box scrolls down: the page does");
	wide.overflowX = "hidden";
	pane.overflowY = "auto";
	r = await scroll({ dx: 40 });
	assert.deepEqual([pane.scrollLeft, win.scrollX], [0, 40], "a pane that only scrolls down takes no dx");
});
