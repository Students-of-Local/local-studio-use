// One driver per rival tool, with the same verbs as Local Studio's driver (../tasks/lib.mjs), so every tool runs the same solve logic (../tasks/solves.mjs).
// Each verb is the fewest tool calls that tool needs for it; `s.calls` counts them. Targets are found by
// role and accessible name from the tool's own snapshot, never by a CSS selector or page JavaScript.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { counter } from "./mcp.mjs";

const run = promisify(execFile);

/** Parse `- role "name" [ref=e12]` lines (Playwright MCP, browse, agent-browser snapshots), in document order. */
export function parseAria(text) {
	const nodes = [];
	for (const line of String(text).split("\n")) {
		const m = /^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
		if (!m) continue;
		// Playwright/agent-browser: `[ref=e12]`; browse: `[ref=e3 selected="x" 4 options]`; a heading may have no ref.
		const ref = /[[ ,]ref=@?([a-z0-9]+)[\],\s]/.exec(line)?.[1];
		nodes.push({ role: m[1], name: (m[2] ?? "").replace(/\\"/g, '"'), ref, line });
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

export function playwrightDriver(ctx) {
	const s = counter(ctx.call);
	return {
		s,
		open: (url) => s.tool("browser_navigate", { url }),
		async nodes() {
			return parseAria(await s.tool("browser_snapshot", {}));
		},
		text: () => s.tool("browser_snapshot", {}),
		search: (q) => s.tool("browser_find", { text: q }),
		click: (n) => s.tool("browser_click", { element: n.name || n.role, target: n.ref }),
		fill: (n, text) => s.tool("browser_type", { element: n.name || n.role, target: n.ref, text }),
		check: (n) => s.tool("browser_click", { element: n.name || n.role, target: n.ref }),
		select: (n, v) => s.tool("browser_select_option", { element: n.name, target: n.ref, values: [v] }),
		async upload(n, path) {
			await s.tool("browser_click", { element: n.name || "file input", target: n.ref });
			return s.tool("browser_file_upload", { paths: [path] });
		},
		dialog: (accept, promptText) => s.tool("browser_handle_dialog", promptText === undefined ? { accept } : { accept, promptText }),
		async clickNewTab(n) {
			await s.tool("browser_click", { element: n.name, target: n.ref });
			const list = await s.tool("browser_tabs", { action: "list" });
			const idx = [...list.matchAll(/^- (\d+):/gm)].map((m) => Number(m[1]));
			await s.tool("browser_tabs", { action: "select", index: Math.max(...idx) });
		},
		backToFirst: () => s.tool("browser_tabs", { action: "select", index: 0 }),
	};
}

export function browseDriver(ctx) {
	const s = counter(ctx.call);
	let tab;
	let first;
	return {
		s,
		async open(url) {
			const r = json(await s.tool("navigate", { url }));
			tab = first = r.tab;
			return r;
		},
		// browse scopes to <main> and says what it left out; an agent that reads that note asks again for the body.
		async nodes() {
			let t = await s.tool("snapshot", { tab, compact: false });
			if (/not shown \(within: "body"/.test(t)) t = await s.tool("snapshot", { tab, compact: false, within: "body" });
			return parseAria(t);
		},
		async text() {
			const t = await s.tool("snapshot", { tab, compact: false });
			return /not shown \(within: "body"/.test(t) ? s.tool("snapshot", { tab, compact: false, within: "body" }) : t;
		},
		search: (q) => s.tool("snapshot", { tab, find: q }),
		click: (n) => s.tool("click", { tab, ref: n.ref }),
		fill: (n, value) => s.tool("fill", { tab, ref: n.ref, value }),
		check: (n) => s.tool("fill", { tab, ref: n.ref, checked: true }),
		select: (n, v) => s.tool("select", { tab, ref: n.ref, values: v }),
		upload: (n, path) => s.tool("upload", { tab, ref: n.ref, files: [path] }),
		dialog: (accept, promptText) => s.tool("dialog", { tab, action: accept ? "accept" : "dismiss", ...(promptText !== undefined ? { promptText } : {}) }),
		async clickNewTab(n) {
			const r = json(await s.tool("click", { tab, ref: n.ref }));
			const t = r.newTabs?.[0]?.tab ?? r.newTabs?.[0]?.id ?? r.newTabs?.[0];
			if (t === undefined) throw new Error(`click reported no new tab: ${JSON.stringify(r).slice(0, 300)}`);
			tab = t;
		},
		backToFirst() {
			tab = first;
		},
	};
}

export function agentBrowserDriver(ctx) {
	const call = async (cmd, args = []) => {
		try {
			const { stdout, stderr } = await run(ctx.bin, [cmd, ...args], { env: { ...process.env, ...ctx.env }, timeout: 60_000, maxBuffer: 20e6 });
			return { ok: true, text: stdout + (stderr ? `\n${stderr}` : "") };
		} catch (e) {
			return { ok: false, text: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
		}
	};
	const s = counter((name, args) => call(name, args));
	return {
		s,
		open: (url) => s.tool("open", [url]),
		async nodes() {
			return parseAria(await s.tool("snapshot", []));
		},
		text: () => s.tool("snapshot", []),
		search: (q) => s.tool("snapshot", []),
		click: (n) => s.tool("click", [`@${n.ref}`]),
		fill: (n, v) => s.tool("fill", [`@${n.ref}`, v]),
		check: (n) => s.tool("check", [`@${n.ref}`]),
		select: (n, v) => s.tool("select", [`@${n.ref}`, v]),
		upload: (n, path) => s.tool("upload", [`@${n.ref}`, path]),
		dialog: (accept, promptText) => s.tool("dialog", accept ? ["accept", ...(promptText !== undefined ? [promptText] : [])] : ["dismiss"]),
		async clickNewTab(n) {
			await s.tool("click", [`@${n.ref}`]);
			const list = await s.tool("tab", ["list"]);
			const ids = [...list.matchAll(/\[(t\d+)\]/g)].map((m) => m[1]);
			await s.tool("tab", [ids[ids.length - 1]]);
		},
		async backToFirst() {
			const list = await s.tool("tab", ["list"]);
			const ids = [...list.matchAll(/\[(t\d+)\]/g)].map((m) => m[1]);
			return s.tool("tab", [ids[0]]);
		},
	};
}

/** Parse `uid=1_5 textbox "Full name"` lines (Chrome DevTools MCP's take_snapshot), in document order. A line with no role is static text. */
export function parseUids(text) {
	const nodes = [];
	for (const line of String(text).split("\n")) {
		const m = /^\s*uid=(\S+)(?: ([A-Za-z]+))?(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
		if (m) nodes.push({ ref: m[1], role: m[2] ?? "StaticText", name: (m[3] ?? "").replace(/\\"/g, '"'), line });
	}
	return nodes;
}

const plainSnapshot = (t) => String(t).replace(/^\s*uid=\S+ (?:[A-Za-z]+ )?/gm, "");

/** Chrome DevTools MCP routes each call by page id; the driver keeps the page it opened and the one a click opened. */
export function chromeDevtoolsDriver(ctx) {
	const s = counter(ctx.call);
	let page;
	const on = (args) => ({ pageId: page, ...args });
	return {
		s,
		async open(url) {
			ctx.first ??= Number(/^(\d+):/m.exec(await s.tool("list_pages", {}))?.[1] ?? 1);
			page = ctx.first;
			return s.tool("navigate_page", on({ url }));
		},
		async nodes() {
			return parseUids(await s.tool("take_snapshot", on({})));
		},
		// Page text is the snapshot without its uid and role markup, as solves.mjs's flat() drops other tools' refs.
		text: async () => plainSnapshot(await s.tool("take_snapshot", on({}))),
		search: async () => plainSnapshot(await s.tool("take_snapshot", on({}))),
		click: (n) => s.tool("click", on({ uid: n.ref })),
		fill: (n, value) => s.tool("fill", on({ uid: n.ref, value })),
		check: (n) => s.tool("click", on({ uid: n.ref })),
		select: (n, value) => s.tool("fill", on({ uid: n.ref, value })),
		upload: (n, path) => s.tool("upload_file", on({ uid: n.ref, filePaths: [path] })),
		dialog: (accept, promptText) => s.tool("handle_dialog", on({ action: accept ? "accept" : "dismiss", ...(promptText !== undefined ? { promptText } : {}) })),
		// The click's result lists the pages it opened ("## Opened pages", then "2: title (url)").
		async clickNewTab(n) {
			const r = await s.tool("click", on({ uid: n.ref }));
			const id = /## Opened pages\n(\d+):/.exec(r)?.[1];
			if (id === undefined) throw new Error(`click reported no new page: ${r.slice(0, 300)}`);
			page = Number(id);
		},
		backToFirst() {
			page = ctx.first;
		},
	};
}

export const drivers = { "playwright-mcp": playwrightDriver, browse: browseDriver, "agent-browser": agentBrowserDriver, "chrome-devtools-mcp": chromeDevtoolsDriver };
