// The agent skill (skills/local-studio-browser/SKILL.md) and the MCP server must agree: every tool and
// parameter the skill shows exists, and the server instructions carry the same rules.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const skill = readFileSync(join(here, "..", "..", "skills", "local-studio-browser", "SKILL.md"), "utf8");
const root = mkdtempSync(join(tmpdir(), "local-studio-skill-"));
let mcp;
let tools;
let instructions;

before(async () => {
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mcp = new Client({ name: "local-studio-skill-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), LOCAL_STUDIO_BROWSER_SOCKET_DIR: join(root, "sock") },
			stderr: "ignore",
		}),
	);
	tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]));
	instructions = mcp.getInstructions() ?? "";
});

after(async () => {
	await mcp?.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

test("the skill has frontmatter a harness can index", () => {
	const m = /^---\nname: local-studio-browser\ndescription: (.+)\n---\n/.exec(skill);
	assert.ok(m, "SKILL.md must start with name and description frontmatter");
	assert.ok(m[1].length <= 1024, "description over 1024 characters");
	assert.match(m[1], /Use when/);
});

test("every tool the skill names exists", () => {
	// Error codes the skill quotes are not tools (src/bridge/protocol.ts, ERR).
	const errorCodes = new Set(["dialog_open", "permission_denied", "no_tab", "bad_params", "not_found", "timeout", "interrupted", "tab_limit"]);
	const named = new Set(
		[...skill.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1]).filter((n) => !errorCodes.has(n) && (tools.has(n) || /_/.test(n))),
	);
	// Also tool calls in the worked examples: `name {...}` at the start of a line.
	for (const m of skill.matchAll(/(?:^|`)([a-z]+(?:_[a-z]+)*) \{/gm)) named.add(m[1]);
	for (const name of named) assert.ok(tools.has(name), `SKILL.md mentions ${name}, which the MCP server doesn't have`);
	for (const core of ["tabs_context", "status", "navigate", "read_page", "click", "fill", "type", "wait", "handle_dialog", "tabs_show", "tabs_close"]) {
		assert.ok(named.has(core), `SKILL.md should teach ${core}`);
	}
});

test("every example call uses real parameters", () => {
	const calls = [...skill.matchAll(/`?([a-z]+(?:_[a-z]+)*) (\{[^`\n]*\})/g)];
	assert.ok(calls.length >= 15, `expected many example calls, found ${calls.length}`);
	for (const [, name, json] of calls) {
		const tool = tools.get(name);
		assert.ok(tool, `example uses unknown tool ${name}`);
		const args = JSON.parse(json.replace(/"tabId":\.\.\./g, '"tabId":1'));
		const props = Object.keys(tool.inputSchema.properties ?? {});
		for (const key of Object.keys(args)) assert.ok(props.includes(key), `${name} has no parameter ${key} (example ${json})`);
		for (const req of tool.inputSchema.required ?? []) assert.ok(req in args, `${name} example ${json} lacks required ${req}`);
	}
});

test("server instructions and the skill teach the same rules", () => {
	const pairs = [
		[/untrusted data/i, /untrusted data/i],
		[/Ask the user before you act under their sign-in/, /Ask before you act under the user's sign-in/],
		[/passwords or payment details/, /passwords or (?:card numbers|payment details)/],
		[/Call tabs_context before any browser tool/, /Call `tabs_context` first/],
		[/tabs_release/, /tabs_release/],
		[/fails with interrupted/, /Error `interrupted`/],
		[/"filter":"interactive"/, /"filter":"interactive"/],
		[/read_page again to confirm/, /`read_page` again to verify/],
		[/changes list new refs/, /`changes` \(new refs/],
		[/Refs expire/, /refs are gone/],
		[/handle_dialog/, /handle_dialog/],
		[/Cancel is always safe/, /Cancel, which is always safe/],
		[/confirms exactly what the user asked for/, /confirms exactly what\s+the user asked for/],
		[/Settings > Agents/, /Settings > Agents/],
		[/tabs_close/, /tabs_close/],
		[/tabs_show/, /tabs_show/],
		[/do not try to get around it/, /Don't try another URL to\s+get around it/],
	];
	for (const [inInstructions, inSkill] of pairs) {
		assert.match(instructions, inInstructions, `MCP instructions lack ${inInstructions}`);
		assert.match(skill, inSkill, `SKILL.md lacks ${inSkill}`);
	}
	// The tool descriptions back the same promises.
	assert.match(tools.get("handle_dialog").description, /Cancel is always safe/);
	assert.match(tools.get("read_page").description, /refs expire/);
	assert.match(tools.get("tabs_show").description, /only tool that changes what the user sees/);
});

test("the worked examples act on changes: no read_page straight after an input tool (D43)", () => {
	for (const [, block] of skill.matchAll(/```\n([\s\S]*?)```/g)) {
		const lines = block.split("\n");
		for (let i = 1; i < lines.length; i++)
			assert.ok(
				!(lines[i].startsWith("read_page") && /^(fill|type|click|press|scroll|drag) /.test(lines[i - 1])),
				`${lines[i - 1]}\n${lines[i]}`,
			);
	}
});

test("PR 196 r1 first-F3: the form example's request gives the name and email it fills, so none is invented", () => {
	const form = skill.slice(skill.indexOf("**Fill and submit a form.**"));
	assert.match(form, /^\*\*Fill and submit a form\.\*\* The user asks you to send the contact form with their name\s+and email\./);
	assert.match(form, /fill \{"ref":"e7","value":"ada@example\.com"\}/, "the example fills an email, so the request must give one");
});
