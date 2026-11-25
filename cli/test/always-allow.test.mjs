import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { claudeAllows, setClaudeAllows, CLAUDE_RULE } = await loadTs(
	`export { claudeAllows, setClaudeAllows, CLAUDE_RULE } from "@src/always-allow.ts";`,
);

const home = () => {
	const dir = mkdtempSync(join(tmpdir(), "always-allow-"));
	mkdirSync(join(dir, ".claude"));
	return dir;
};

test("the rule covers every Local Studio tool and nothing else", () => {
	assert.equal(CLAUDE_RULE, "mcp__local-studio");
});

test("on and off change only the one rule", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(file, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"], deny: ["Read(x)"] } }));
	assert.equal(claudeAllows(dir), false);
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.equal(claudeAllows(dir), true);
	const on = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(on.permissions, { allow: ["Bash(ls)", "mcp__local-studio"], deny: ["Read(x)"] });
	assert.equal(on.model, "opus");
	setClaudeAllows(true, dir);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions.allow, ["Bash(ls)", "mcp__local-studio"], "not added twice");
	setClaudeAllows(false, dir);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions.allow, ["Bash(ls)"]);
});

test("no settings file yet is fine", () => {
	const dir = home();
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.equal(claudeAllows(dir), true);
});

test("a file it can't read is left alone", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(file, "{ not json");
	assert.match(setClaudeAllows(true, dir), /left alone/);
	assert.equal(readFileSync(file, "utf8"), "{ not json");
	assert.equal(claudeAllows(dir), false);
});

test("on and off never touch another server's rules", () => {
	const dir = home();
	const file = join(dir, ".claude", "settings.json");
	writeFileSync(file, JSON.stringify({ permissions: { allow: ["mcp__another", "mcp__another__*"], deny: ["mcp__another__run_js"] } }));
	setClaudeAllows(true, dir);
	setClaudeAllows(false, dir);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, { allow: ["mcp__another", "mcp__another__*"], deny: ["mcp__another__run_js"] });
});

test("the file keeps its permissions and stays where a symlink points", () => {
	const dir = home();
	const real = join(dir, "dotfiles.json");
	writeFileSync(real, "{}", { mode: 0o600 });
	symlinkSync(real, join(dir, ".claude", "settings.json"));
	assert.equal(setClaudeAllows(true, dir), undefined);
	assert.ok(lstatSync(join(dir, ".claude", "settings.json")).isSymbolicLink(), "still a link");
	assert.equal(statSync(real).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).permissions.allow, ["mcp__local-studio"]);
});

test("off also removes the wildcard form of the rule", () => {
	const dir = home();
	writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__local-studio__*", "Bash(ls)"] } }));
	setClaudeAllows(false, dir);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).permissions.allow, ["Bash(ls)"]);
});
