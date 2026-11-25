// The Local Studio side of the task set: the repo's own e2e harness (built extension, native host and MCP server in a
// throwaway headless Chromium) and the driver verbs solves.mjs is written against. Adapted from the study's
// adapters/local-studio-browser.mjs and lib/drivers.mjs (README.md, "Origin").
import { execFileSync } from "node:child_process";
import { startHarness } from "../../../cli/test/e2e-harness.mjs";

/** Start the harness with the two task hosts allowed, as a person allows them in the side panel. */
export async function startLocalStudio() {
	const asked = [];
	const h = await startHarness({
		name: "task-set",
		// A question to the person (an upload) is answered yes, as the person running the task would.
		onElicit: async (req) => {
			asked.push(req.params.message);
			const content = {};
			for (const [k, v] of Object.entries(req.params.requestedSchema?.properties ?? {})) content[k] = v.enum ? v.enum[0] : true;
			return { action: "accept", content };
		},
	});
	await h.connected();
	for (const host of ["127.0.0.1", "localhost"]) execFileSync(process.execPath, [h.cli, "allow", host], { env: h.env(), stdio: "ignore" });
	return { h, asked, call: h.call };
}

/** Wrap a call function with a step counter; `tool` throws on a tool error. */
export function counter(call) {
	let calls = 0;
	let cancelled = false;
	return {
		get calls() {
			return calls;
		},
		cancel() {
			cancelled = true;
		},
		async tool(name, args) {
			if (cancelled) throw new Error("cancelled after timeout");
			calls++;
			const r = await call(name, args);
			if (!r.ok) throw new Error(`${name} failed: ${r.text.slice(0, 400)}`);
			return r.text;
		},
	};
}

/** read_page / find lines: `e12 button "Save" ...`. The same parser dom-bench uses. */
export function parseNodes(text) {
	const nodes = [];
	const body = String(text).split(/\n\s*\nText:\n/)[0];
	for (const line of body.split("\n")) {
		const m = /^(\S+) (\S+) ("(?:[^"\\]|\\.)*")(.*)$/.exec(line);
		if (!m) continue;
		try {
			nodes.push({ ref: m[1], role: m[2], name: JSON.parse(m[3]), line });
		} catch {}
	}
	return nodes;
}

const json = (t) => {
	try {
		return JSON.parse(t);
	} catch {
		const m = /\{[\s\S]*\}/.exec(t);
		try {
			return m ? JSON.parse(m[0]) : {};
		} catch {
			return {};
		}
	}
};

/** The driver verbs (open, nodes, text, search, click, fill, check, select, upload, dialog, clickNewTab, backToFirst). */
export function driver(ctx) {
	const s = counter(ctx.call);
	let first;
	return {
		s,
		async open(url) {
			const r = json(await s.tool("navigate", { url }));
			first = r.tabId;
			return r;
		},
		async nodes() {
			return parseNodes(await s.tool("read_page", { filter: "all", maxNodes: 2000 }));
		},
		text: async () => json(await s.tool("get_page_text", {})).text ?? "",
		search: async (q) => JSON.stringify(json(await s.tool("get_page_text", { query: q }))),
		click: (n) => s.tool("click", { ref: n.ref }),
		fill: (n, value) => s.tool("fill", { ref: n.ref, value }),
		check: (n) => s.tool("click", { ref: n.ref }),
		select: (n, value) => s.tool("fill", { ref: n.ref, value }),
		upload: (n, path) => s.tool("files", { action: "upload", ref: n.ref, paths: [path] }),
		dialog: (accept, promptText) => s.tool("handle_dialog", promptText === undefined ? { accept } : { accept, promptText }),
		// The click's result names the tab it opened (newTabs), so no tabs_context call is needed to find it.
		async clickNewTab(n) {
			const r = json(await s.tool("click", { ref: n.ref }));
			const tabId = r.newTabs?.[r.newTabs.length - 1]?.tabId;
			if (tabId === undefined) throw new Error(`click reported no new tab: ${JSON.stringify(r).slice(0, 300)}`);
			await s.tool("tabs_select", { tabId });
		},
		backToFirst: () => s.tool("tabs_select", { tabId: first }),
	};
}
