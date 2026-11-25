/**
 * "Always allow" for Claude Code: its own permission prompt for Local Studio's tools. One rule in its user settings, which
 * only this command writes. Other tools keep asking.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_NAME } from "./harness.ts";

/** Claude Code's rule for every tool of one MCP server. */
export const CLAUDE_RULE = `mcp__${MCP_NAME}`;

function settingsFile(home = homedir()): string {
	return join(home, ".claude", "settings.json");
}

export function claudeAllows(home = homedir()): boolean {
	try {
		const settings = JSON.parse(readFileSync(settingsFile(home), "utf8")) as { permissions?: { allow?: unknown } };
		const allow = settings.permissions?.allow;
		return Array.isArray(allow) && allow.includes(CLAUDE_RULE);
	} catch {
		return false;
	}
}

/** Adds or removes the rule and leaves everything else as it was. Returns why it couldn't, or undefined. */
export function setClaudeAllows(on: boolean, home = homedir()): string | undefined {
	const file = settingsFile(home);
	let settings: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			return `${file} isn't valid JSON, so it was left alone.`;
		}
	}
	const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
	const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
	const next = on ? [...new Set([...allow, CLAUDE_RULE])] : allow.filter((rule) => rule !== CLAUDE_RULE && rule !== `${CLAUDE_RULE}__*`);
	settings.permissions = { ...permissions, allow: next };
	write(file, settings);
	return undefined;
}

/** Atomically, through a symlink to where the file really lives, keeping its permissions. */
function write(file: string, settings: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true });
	const target = existsSync(file) ? realpathSync(file) : file;
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
	const temporary = `${target}.local-studio-tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: mode ?? 0o600 });
	if (mode !== undefined) chmodSync(temporary, mode);
	renameSync(temporary, target);
}
