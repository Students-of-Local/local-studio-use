// The hands protocol (docs/hands-protocol.md) as checks any computer-use helper must pass. hands-conformance.test.mjs runs
// them against the fake helper, against broken copies of it (each must fail), and against a real helper when one is named.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const S = "string";
const I = "integer";
const B = "boolean";
const STRINGS = "array<string>";
const OBJECTS = "array<object>";

/** Every helper lists these 17, with exactly these required arguments and at least these properties, of these types. */
export const VERBS = {
	windows: { readOnly: true, required: [], props: {} },
	snapshot: { readOnly: true, required: [], props: { app: S, window: I, query: S, since: S, max_elements: I, format: S, interactive: B, compact: B, depth: I, screenshot: B, zoom: S } },
	find: { readOnly: true, required: [], props: { app: S, window: I, role: S, name: S, text: S, value: S, limit: I } },
	get: { readOnly: true, required: ["ref"], props: { ref: S, property: S, copy: B } },
	shot: { readOnly: false, required: ["window"], props: { window: I, out: S, zoom: S, cursor: B } },
	click: { readOnly: false, required: [], props: { ref: S, window: I, text: S, role: S, button: S, item: S, wait: I } },
	type: { readOnly: false, required: ["ref"], props: { ref: S, text: S, paste: B, wait: I } },
	set_value: { readOnly: false, required: ["ref", "value"], props: { ref: S, value: S, wait: I } },
	press: { readOnly: false, required: ["ref", "key"], props: { ref: S, key: S, wait: I } },
	click_at: { readOnly: false, required: ["window", "x", "y"], props: { window: I, x: I, y: I, count: I, button: S, item: S, wait: I } },
	drag: { readOnly: false, required: ["window", "x", "y", "x2", "y2"], props: { window: I, x: I, y: I, x2: I, y2: I, steps: I, wait: I } },
	scroll: { readOnly: false, required: ["ref", "direction"], props: { ref: S, direction: S, amount: I, wait: I } },
	select: { readOnly: false, required: ["ref", "option"], props: { ref: S, option: S, wait: I } },
	toggle: { readOnly: false, required: ["ref"], props: { ref: S, wait: I } },
	menu: { readOnly: false, required: ["window", "path"], props: { window: I, path: S, wait: I } },
	run_steps: { readOnly: false, required: ["steps"], props: { steps: OBJECTS, wait: I } },
	open: { readOnly: false, required: ["app"], props: { app: S, targets: STRINGS, new_window: B, wait: I } },
};

/** The person's verbs and the name Local Studio answers itself: never listed. */
export const NEVER_LISTED = ["lend", "return", "status"];
/** What `--connector` may answer `initialize` with. */
export const CONNECTOR_NAMES = ["local-studio-connector"];
/** Verbs that manage windows: refused to a connector whether or not the helper has them. */
export const MANAGING = ["arrange", "move", "close", "switch", "focus", "frame"];
/** Arguments each managing verb accepts, so a refusal is the cap's and not the argument check's. */
const MANAGING_ARGS = { arrange: { layout: "full" }, move: { window: 1 }, close: { window: 1 }, switch: { workspace: 1 }, focus: { window: 1 }, frame: { window: 1, frame: "0,0,10,10" } };
export const STEP_TOOLS = ["click", "type", "set_value", "press", "click_at", "drag", "scroll", "select", "toggle", "menu"];
export const ERROR_CODES = [
	"outside_agent_workspace",
	"agent_workspace_off",
	"app_not_found",
	"window_not_found",
	"ambiguous_window",
	"ambiguous",
	"needs_lend",
	"needs_sandbox",
	"in_use",
	"unknown_ref",
	"stale_ref",
	"ambiguous_target",
	"stale_bare_row",
	"not_supported",
	"action_failed",
	"unverified",
	"timeout",
	"permission_denied",
	"bad_arguments",
	"not_running",
	"engine_error",
];

/** One helper process over stdio: raw lines in, parsed replies out by id. */
export class HandsSession {
	constructor(command, args, env = process.env) {
		this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
		this.child.stderr.resume();
		this.lines = [];
		this.waiters = [];
		this.next = 1;
		this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
		this.child.stdin.on("error", () => {});
		createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
			this.lines.push(line);
			for (const w of this.waiters.splice(0)) w();
		});
	}

	/** Sends one raw line. */
	send(line) {
		this.child.stdin.write(`${line}\n`);
	}

	/** The next reply line whose JSON matches `pick`, or a failure after `ms`. */
	async take(pick, ms = 10_000) {
		const deadline = Date.now() + ms;
		for (;;) {
			const i = this.lines.findIndex((l) => {
				try {
					return pick(JSON.parse(l));
				} catch {
					return false;
				}
			});
			if (i >= 0) return JSON.parse(this.lines.splice(i, 1)[0]);
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no matching reply within ${ms} ms; got: ${this.lines.join(" | ") || "nothing"}`);
			await new Promise((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiters.push(() => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}

	async request(method, params = {}) {
		const id = this.next++;
		this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return this.take((m) => m.id === id);
	}

	async result(method, params) {
		const m = await this.request(method, params);
		assert.equal(m.jsonrpc, "2.0");
		assert.ok(!m.error, `${method} answered an error: ${JSON.stringify(m.error)}`);
		return m.result;
	}

	async initialize() {
		return this.result("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-studio-browser", version: "1" } });
	}

	/** A tools/call's result and its first part's envelope (undefined for rows). */
	async call(name, args = {}) {
		const r = await this.result("tools/call", { name, arguments: args });
		assert.ok(Array.isArray(r.content) && r.content.length > 0, `${name}: content is a non-empty list`);
		assert.equal(typeof r.isError, "boolean", `${name}: isError is a boolean`);
		const first = r.content[0];
		assert.equal(first.type, "text");
		let envelope;
		try {
			envelope = JSON.parse(first.text);
		} catch {}
		return { result: r, envelope };
	}

	close() {
		this.child.stdin.end();
		setTimeout(() => this.child.kill(), 2000).unref();
		return this.exited;
	}
}

function propType(p) {
	if (p?.type === "array") return `array<${p.items?.type ?? "?"}>`;
	return p?.type;
}

/** An error envelope of `code`, with every field the protocol says it carries. */
export function assertError(call, code, retry) {
	const { result, envelope } = call;
	assert.equal(result.isError, true, `isError for an expected ${code}`);
	assert.ok(envelope, `the error is an envelope, got: ${result.content[0].text}`);
	assert.equal(envelope.ok, false);
	const e = envelope.error;
	assert.ok(e && typeof e === "object", "error is an object");
	assert.ok(ERROR_CODES.includes(e.code), `error.code ${e.code} is a protocol code`);
	assert.equal(e.code, code, `error.code: ${JSON.stringify(e)}`);
	assert.equal(typeof e.message, "string");
	assert.equal(typeof e.suggestion, "string");
	assert.ok(["safe", "after_snapshot", "never"].includes(e.retry), `retry ${e.retry}`);
	if (retry) assert.equal(e.retry, retry, `retry for ${code}`);
	assert.ok("next_call" in e, "every error carries next_call");
	if (e.next_call !== null) {
		assert.equal(typeof e.next_call.tool, "string");
		assert.equal(typeof e.next_call.arguments, "object");
	}
	return e;
}

/**
 * The checks. Each takes a function that starts a session (`start(["mcp"])` or `start(["mcp", "--connector"])`) and
 * closes what it starts. Names are what the test runner prints.
 */
export const CHECKS = [
	{
		name: "initialize answers protocolVersion, tools capability and a local serverInfo name",
		async run(start) {
			const s = start(["mcp"]);
			try {
				const r = await s.initialize();
				assert.equal(r.protocolVersion, "2025-06-18");
				assert.ok(r.capabilities?.tools, "capabilities.tools");
				assert.equal(typeof r.serverInfo?.name, "string");
				assert.equal(typeof r.serverInfo?.version, "string");
				assert.ok(!CONNECTOR_NAMES.includes(r.serverInfo.name), `a local helper never answers as a connector (${r.serverInfo.name})`);
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "--connector answers initialize with a connector name",
		async run(start) {
			const s = start(["mcp", "--connector"]);
			try {
				const r = await s.initialize();
				assert.ok(CONNECTOR_NAMES.includes(r.serverInfo?.name), `serverInfo.name ${r.serverInfo?.name} is one of ${CONNECTOR_NAMES.join(", ")}`);
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "transport: ping, parse error, unknown method, notifications and blank lines",
		async run(start) {
			const s = start(["mcp"]);
			try {
				await s.initialize();
				assert.deepEqual(await s.result("ping"), {});
				s.send("");
				s.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
				s.send("this is not json");
				const parse = await s.take((m) => m.id === null);
				assert.equal(parse.error?.code, -32700);
				const unknown = await s.request("no/such/method");
				assert.equal(unknown.error?.code, -32601);
				assert.match(unknown.error.message, /^method not found/);
				const noName = await s.request("tools/call", { arguments: {} });
				assert.equal(noName.error?.code, -32602);
				// Nothing answered the notification or the blank line: the next reply is the ping's.
				const ping = await s.request("ping");
				assert.deepEqual(ping.result, {});
				assert.deepEqual(s.lines, [], "no stray replies");
			} finally {
				await s.close();
			}
		},
	},
	...Object.entries(VERBS).map(([verb, spec]) => ({
		name: `lists ${verb} with its required arguments, types and readOnlyHint`,
		async run(start, cache) {
			const tools = await listed(start, cache);
			const tool = tools.find((t) => t.name === verb);
			assert.ok(tool, `tools/list has ${verb}`);
			assert.equal(typeof tool.description, "string");
			assert.ok(tool.description.length > 0, "a description");
			assert.equal(tool.inputSchema?.type, "object");
			assert.equal(tool.inputSchema.additionalProperties, false, "additionalProperties: false");
			assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [...spec.required].sort(), `${verb} required`);
			for (const [name, type] of Object.entries(spec.props)) {
				assert.equal(propType(tool.inputSchema.properties?.[name]), type, `${verb}.${name} is ${type}`);
			}
			assert.equal(tool.annotations?.readOnlyHint, spec.readOnly, `${verb} readOnlyHint`);
		},
	})),
	{
		name: "never lists lend, return or status, in either mode, and every name is snake case",
		async run(start, cache) {
			for (const args of [["mcp"], ["mcp", "--connector"]]) {
				const tools = await listed(start, cache, args);
				const names = tools.map((t) => t.name);
				for (const never of NEVER_LISTED) assert.ok(!names.includes(never), `${args.join(" ")} lists ${never}`);
				for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/);
				assert.equal(new Set(names).size, names.length, "no name twice");
			}
		},
	},
	{
		name: "lend and return answer needs_lend, retry never, in either mode",
		async run(start) {
			for (const args of [["mcp"], ["mcp", "--connector"]]) {
				const s = start(args);
				try {
					await s.initialize();
					assertError(await s.call("lend", { app: "TextEdit" }), "needs_lend", "never");
					assertError(await s.call("return", { app: "TextEdit" }), "needs_lend", "never");
				} finally {
					await s.close();
				}
			}
		},
	},
	{
		name: "argument checks answer bad_arguments before anything runs",
		async run(start) {
			const s = start(["mcp"]);
			try {
				await s.initialize();
				assertError(await s.call("status"), "bad_arguments");
				assertError(await s.call("no_such_verb"), "bad_arguments");
				assertError(await s.call("windows", { nope: 1 }), "bad_arguments");
				assertError(await s.call("click_at", { window: 1, x: 3 }), "bad_arguments");
				assertError(await s.call("click_at", { window: "one", x: 1, y: 1 }), "bad_arguments");
				assertError(await s.call("get", {}), "bad_arguments");
				assertError(await s.call("type", { ref: "1" }), "bad_arguments");
				assertError(await s.call("type", { ref: "1", text: "a", paste: true }), "bad_arguments");
				assertError(await s.call("click", { ref: "1", text: "OK" }), "bad_arguments");
				assertError(await s.call("click", { text: "OK" }), "bad_arguments");
				assertError(await s.call("snapshot", {}), "bad_arguments");
				assertError(await s.call("snapshot", { window: 1, format: "xml" }), "bad_arguments");
				assertError(await s.call("snapshot", { window: 1, since: "yesterday" }), "bad_arguments");
				assertError(await s.call("toggle", { ref: "1", wait: 121 }), "bad_arguments");
				assertError(await s.call("open", { app: "TextEdit", targets: [1] }), "bad_arguments");
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "run_steps refuses a step that isn't an acting verb, and runs nothing",
		async run(start) {
			const s = start(["mcp"]);
			try {
				await s.initialize();
				assertError(await s.call("run_steps", { steps: [] }), "bad_arguments");
				assertError(await s.call("run_steps", { steps: ["click"] }), "bad_arguments");
				for (const bad of ["snapshot", "open", "run_steps", "lend", "move", "status"]) {
					const e = assertError(await s.call("run_steps", { steps: [{ tool: "click", args: { ref: "1" } }, { tool: bad, args: {} }] }), "bad_arguments");
					assert.match(e.message, new RegExp(`step 2: ${bad} can't be a step`), e.message);
				}
				const tooMany = Array.from({ length: 33 }, () => ({ tool: "toggle", args: { ref: "1" } }));
				assertError(await s.call("run_steps", { steps: tooMany }), "bad_arguments");
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "windows answers an envelope with agent_workspace, access and windows",
		async run(start) {
			const s = start(["mcp"]);
			try {
				await s.initialize();
				const { result, envelope } = await s.call("windows");
				assert.ok(envelope, result.content[0].text);
				if (!envelope.ok) {
					// A helper without its OS grant still answers in the protocol's words.
					assertError({ result, envelope }, envelope.error.code);
					return;
				}
				assert.equal(result.isError, false);
				assert.ok("agent_workspace" in envelope.data);
				assert.ok(["read_only", "default", "full"].includes(envelope.data.access), `access ${envelope.data.access}`);
				assert.ok(Array.isArray(envelope.data.windows));
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "a helper without its OS grant refuses open as it refuses windows",
		async run(start) {
			const s = start(["mcp"]);
			try {
				await s.initialize();
				const { result, envelope } = await s.call("windows");
				if (envelope?.ok || envelope?.error.code !== "permission_denied") return;
				assert.ok(envelope.error.suggestion, result.content[0].text);
				assertError(await s.call("open", { app: "TextEdit" }), "permission_denied");
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "connector cap: access is the person's mode capped at Default, managing verbs are refused, lending is refused",
		async run(start) {
			const local = await accessOf(start, ["mcp"]);
			const s = start(["mcp", "--connector"]);
			try {
				await s.initialize();
				const { result, envelope } = await s.call("windows");
				assert.ok(envelope, result.content[0].text);
				if (envelope.ok) {
					assert.ok(["read_only", "default"].includes(envelope.data.access), `a connector works under ${envelope.data.access}`);
					// Full Access becomes Default; Read Only stays Read Only (docs/hands-protocol.md).
					if (local) assert.equal(envelope.data.access, local === "full" ? "default" : local, `the person's mode is ${local}, so a connector works under ${local === "full" ? "default" : local}`);
				} else assert.notEqual(envelope.error.code, "bad_arguments", "windows is a connector verb");
				for (const verb of MANAGING) {
					const e = assertError(await s.call(verb, MANAGING_ARGS[verb]), "permission_denied", "never");
					assert.match(e.message, new RegExp(`${verb} isn't open to an assistant connected from another machine`));
				}
				assertError(await s.call("lend", { app: "TextEdit" }), "needs_lend", "never");
			} finally {
				await s.close();
			}
		},
	},
	{
		name: "read only: acting verbs are refused with permission_denied, shot is not",
		async run(start) {
			for (const args of [["mcp"], ["mcp", "--connector"]]) {
				if ((await accessOf(start, args)) !== "read_only") continue;
				const s = start(args);
				try {
					await s.initialize();
					assertError(await s.call("toggle", { ref: "1" }), "permission_denied", "never");
					assertError(await s.call("click_at", { window: 1, x: 1, y: 1 }), "permission_denied", "never");
					const shot = await s.call("shot", { window: 1 });
					// The mode's refusal is never worth retrying; a missing OS grant's is.
					assert.ok(!(shot.envelope && shot.envelope.ok === false && shot.envelope.error.code === "permission_denied" && shot.envelope.error.retry === "never"), `shot works under Read Only (${args.join(" ")})`);
				} finally {
					await s.close();
				}
			}
		},
	},
	{
		name: "the helper exits when its input ends",
		async run(start) {
			const s = start(["mcp"]);
			await s.initialize();
			s.child.stdin.end();
			const code = await Promise.race([s.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 5000))]);
			if (code === "still running") s.child.kill();
			assert.equal(code, 0);
		},
	},
];

/** The access a session with `args` reports from `windows`, or undefined when it can't say (no OS grant) and nothing says it. */
async function accessOf(start, args) {
	const told = process.env.LOCAL_STUDIO_COMPUTER_CONFORMANCE_ACCESS;
	if (told) return told;
	const s = start(args);
	try {
		await s.initialize();
		const { envelope } = await s.call("windows");
		return envelope?.ok ? envelope.data.access : undefined;
	} finally {
		await s.close();
	}
}

/** tools/list once per mode per run. */
async function listed(start, cache, args = ["mcp"]) {
	const key = args.join(" ");
	if (!cache.has(key)) {
		cache.set(
			key,
			(async () => {
				const s = start(args);
				try {
					await s.initialize();
					const r = await s.result("tools/list");
					assert.ok(Array.isArray(r.tools), "tools/list answers {tools: [...]}");
					return r.tools;
				} finally {
					await s.close();
				}
			})(),
		);
	}
	return cache.get(key);
}

/** Runs every check; the names and errors of those that failed. */
export async function runAll(start) {
	const cache = new Map();
	const failed = [];
	for (const check of CHECKS) {
		try {
			await check.run(start, cache);
		} catch (err) {
			failed.push({ name: check.name, message: err instanceof Error ? err.message : String(err) });
		}
	}
	return failed;
}
