#!/usr/bin/env node
// A computer-use helper with no desktop behind it: the hands protocol (docs/hands-protocol.md) on the wire, so the
// conformance suite has something to pass in CI. `node fake-hands.mjs mcp [--connector]`.
//
// FAKE_HANDS_ACCESS is the person's access mode here (default full, so the connector cap has something to cap).
// For the suite's own test, FAKE_HANDS_BREAK breaks it on purpose: `drop:<verb>` leaves a verb out of tools/list,
// `connector-name` answers a connector as a local helper, `connector-access` gives a connector Full Access, `connector-readonly` raises a
// Read Only connector to Default, `ignore-readonly` acts under Read Only,
// `connector-manage` lets a connector call the managing verbs.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] !== "mcp") {
	process.stderr.write("usage: fake-hands mcp [--connector]\n");
	process.exit(2);
}
const connector = args.includes("--connector");
const broken = process.env.FAKE_HANDS_BREAK ?? "";
const mode = process.env.FAKE_HANDS_ACCESS ?? "full";
const capped = connector && broken !== "connector-access" && mode === "full" ? "default" : mode;
const access = connector && broken === "connector-readonly" ? "default" : capped;

const S = "string";
const I = "integer";
const B = "boolean";
const wait = ["wait", I, "Seconds to wait, 0 to 120, while the person is using the app."];
const tool = (name, readOnly, params) => ({ name, readOnly, params });
const p = (name, type, help, required = false) => [name, type, help, required];
const ref = p("ref", S, "A ref or a row number from your latest snapshot.", true);

const TOOLS = [
	tool("windows", true, []),
	tool("snapshot", true, [p("app", S, "App"), p("window", I, "Window id"), p("query", S, "Filter"), p("since", S, "latest"), p("max_elements", I, "Rows"), p("format", S, "rows or json"), p("interactive", B, "Actionable only"), p("compact", B, "Collapse"), p("depth", I, "Depth"), p("screenshot", B, "Picture"), p("zoom", S, "Region")]),
	tool("find", true, [p("app", S, "App"), p("window", I, "Window id"), p("role", S, "Role"), p("name", S, "Name"), p("text", S, "Text"), p("value", S, "Value"), p("limit", I, "Limit")]),
	tool("get", true, [ref, p("property", S, "Property"), p("copy", B, "Hold on the agent clipboard")]),
	tool("click", false, [p("ref", S, "A ref"), p("window", I, "Window id"), p("text", S, "Label"), p("role", S, "Role"), p("button", S, "left or right"), p("item", S, "Context menu item"), wait]),
	tool("type", false, [ref, p("text", S, "Text"), p("paste", B, "Paste"), wait]),
	tool("set_value", false, [ref, p("value", S, "Value", true), wait]),
	tool("press", false, [ref, p("key", S, "Keys", true), wait]),
	tool("click_at", false, [p("window", I, "Window id", true), p("x", I, "x", true), p("y", I, "y", true), p("count", I, "Clicks"), p("button", S, "Button"), p("item", S, "Item"), wait]),
	tool("drag", false, [p("window", I, "Window id", true), p("x", I, "x", true), p("y", I, "y", true), p("x2", I, "x2", true), p("y2", I, "y2", true), p("steps", I, "Moves"), wait]),
	tool("scroll", false, [ref, p("direction", S, "Direction", true), p("amount", I, "Notches"), wait]),
	tool("select", false, [ref, p("option", S, "Option", true), wait]),
	tool("menu", false, [p("window", I, "Window id", true), p("path", S, "File > New", true), wait]),
	tool("run_steps", false, [p("steps", "array<object>", "Steps", true), wait]),
	tool("toggle", false, [ref, wait]),
	tool("shot", false, [p("window", I, "Window id", true), p("out", S, "File name"), p("zoom", S, "Region"), p("cursor", B, "Draw the cursor")]),
	tool("open", false, [p("app", S, "App", true), p("targets", "array<string>", "Files"), p("new_window", B, "Fresh window"), wait]),
	// Extensions, as Local Studio had: listed, and refused to a connector.
	tool("move", false, [p("window", I, "Window id", true), p("frame", S, "Frame"), p("workspace", I, "Workspace"), p("display", S, "Display")]),
	tool("close", false, [p("window", I, "Window id", true)]),
	tool("arrange", false, [p("layout", S, "Layout", true), p("windows", "array<string>", "Ids")]),
	tool("switch", false, [p("workspace", I, "Workspace", true), p("display", S, "Display")]),
	tool("focus", false, [p("window", I, "Window id", true)]),
	tool("frame", false, [p("window", I, "Window id", true), p("frame", S, "Frame", true)]),
].filter((t) => !(broken.startsWith("drop:") && t.name === broken.slice(5)));

const MANAGING = new Set(["arrange", "move", "close", "switch", "focus", "frame"]);
const STEPS = ["click", "type", "set_value", "press", "click_at", "drag", "scroll", "select", "toggle", "menu"];
const ACTS = new Set(TOOLS.filter((t) => !t.readOnly && t.name !== "shot").map((t) => t.name));

function schema(t) {
	const properties = {};
	for (const [name, type, help] of t.params) {
		properties[name] = type.startsWith("array<") ? { type: "array", items: { type: type.slice(6, -1) }, description: help } : { type, description: help };
	}
	const required = t.params.filter((x) => x[3]).map((x) => x[0]);
	return { type: "object", properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

const listed = TOOLS.map((t) => ({ name: t.name, description: `The fake's ${t.name}.`, inputSchema: schema(t), annotations: { readOnlyHint: t.readOnly, openWorldHint: false } }));

function err(code, message, retry, suggestion = "See docs/hands-protocol.md.") {
	return { ok: false, error: { code, message, retry, suggestion, next_call: null } };
}
const bad = (why) => err("bad_arguments", why, "safe", "usage: see tools/list");

/** The arguments as the tool takes them, or an error envelope. */
function parse(name, input) {
	if (name === "lend" || name === "return") return err("needs_lend", `agents can't lend apps; ${input.app ?? "the app"} is not on the agent workspace`, "never", "Ask the person to lend it.");
	const t = TOOLS.find((x) => x.name === name);
	if (!t) return bad(`unknown tool ${name}`);
	for (const [k, v] of Object.entries(input)) {
		const param = t.params.find((x) => x[0] === k);
		if (!param) return bad(`unknown argument ${k}`);
		const type = param[1];
		if (type === I && !Number.isInteger(v)) return bad(`${k} takes a number`);
		if (type === B && typeof v !== "boolean") return bad(`${k} takes true or false`);
		if (type === "array<string>" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return bad(`${k} takes a list of strings`);
		if (type === "array<object>" && !(Array.isArray(v) && v.every((x) => x && typeof x === "object" && !Array.isArray(x)))) return bad(`${k} takes a list of objects`);
	}
	for (const [k, , , required] of t.params) if (required && input[k] === undefined) return bad(`${k} is missing`);
	if (name === "type" && (input.text === undefined) === (input.paste !== true)) return bad("pass text or paste: true, not both");
	if (name === "click") {
		if (input.ref !== undefined && (input.text !== undefined || input.role !== undefined)) return bad("pass ref, or window and text, not both");
		if (input.ref === undefined && (input.text === undefined || input.window === undefined)) return bad("ref is missing (or pass window and text)");
	}
	if ((name === "snapshot" || name === "find") && input.app === undefined && input.window === undefined) return bad("say which window: app or window");
	if (name === "snapshot" && input.format !== undefined && !["rows", "json"].includes(input.format)) return bad(`format is rows or json, not ${input.format}`);
	if (name === "snapshot" && input.since !== undefined && input.since !== "latest") return bad(`since takes "latest", not ${input.since}`);
	if (input.wait !== undefined && !(input.wait >= 0 && input.wait <= 120)) return bad(`wait is seconds from 0 to 120, not ${input.wait}`);
	if (name === "run_steps") {
		const steps = input.steps;
		if (steps.length === 0) return bad("steps is missing: pass a list of {tool, args}");
		if (steps.length > 32) return bad(`at most 32 steps, not ${steps.length}`);
		for (const [i, step] of steps.entries()) {
			const raw = step.tool;
			if (typeof raw !== "string") return bad(`step ${i + 1} has no tool`);
			const verb = raw.replace(/^computer_/, "").replaceAll("-", "_");
			if (!STEPS.includes(verb)) return bad(`step ${i + 1}: ${raw} can't be a step; steps are ${STEPS.join(", ")}`);
			const inner = parse(verb, { ...(step.args ?? {}) });
			if (inner.ok === false) return bad(`step ${i + 1} (${verb}): ${inner.error.message}`);
		}
	}
	return { ok: true };
}

function perform(name, input) {
	const checked = parse(name, input);
	if (checked.ok === false) return checked;
	if (connector && MANAGING.has(name) && broken !== "connector-manage") {
		return err("permission_denied", `${name} isn't open to an assistant connected from another machine`, "never", "Arranging, moving and closing windows are for agents on this Mac.");
	}
	if (access === "read_only" && ACTS.has(name) && broken !== "ignore-readonly") return err("permission_denied", `agents have read-only access, so ${name} is refused`, "never");
	if (name === "windows") return { ok: true, data: { agent_workspace: 9, access, windows: [] } };
	// No desktop behind it: every window is gone.
	return err("window_not_found", "no such window (the fake helper has none)", "safe");
}

const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
const name = connector && broken !== "connector-name" ? "local-studio-connector" : "fake-hands";

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
	if (!line.trim()) return;
	let m;
	try {
		m = JSON.parse(line);
	} catch {}
	if (!m || typeof m !== "object" || Array.isArray(m)) return reply(null, { error: { code: -32700, message: "parse error" } });
	if (typeof m.method !== "string" || m.id === undefined) return;
	switch (m.method) {
		case "initialize":
			return reply(m.id, {
				result: {
					protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name, version: "0.0.0-fake" },
					instructions: "A fake helper for the hands conformance suite.",
				},
			});
		case "ping":
			return reply(m.id, { result: {} });
		case "tools/list":
			return reply(m.id, { result: { tools: listed } });
		case "tools/call": {
			if (typeof m.params?.name !== "string") return reply(m.id, { error: { code: -32602, message: "tools/call needs a name" } });
			const envelope = perform(m.params.name, m.params.arguments ?? {});
			return reply(m.id, { result: { content: [{ type: "text", text: JSON.stringify(envelope) }], isError: !envelope.ok } });
		}
		default:
			return reply(m.id, { error: { code: -32601, message: `method not found: ${m.method}` } });
	}
});
lines.on("close", () => process.exit(0));
