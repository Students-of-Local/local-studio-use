/**
 * Skills come from Local Studio's one store. This server has no skills of its own: skill_search and skill_read are passed
 * through to one `local-studio skills mcp`, started at the first call.
 */

import "./cjs-shim.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMPILED, selfExec } from "./self.ts";

export const NO_SKILLS = "Skills come with Local Studio, which isn't installed here. Work without one.";
export const OLD_APP = "The Local Studio app here is older than its skills. Ask the user to update it, and work without one until then.";
export const SKILLS_SILENT = "Skills are not answering.";
/** Set by Local Studio in its own threads, which already have the skills server. */
export const HAS_SKILLS = "LOCAL_STUDIO_SKILLS_SERVER";
const ANSWER_MS = 10_000;
const NAMES = process.platform === "win32" ? ["local-studio-cli.exe", "local-studio.exe"] : ["local-studio-cli", "local-studio", "local-studio-nightly", "local-studio-dev"];

/** The app's names on a Mac, one per release channel (the app's core/src/update/mod.rs). */
const MAC_APPS = ["Local Studio.app", "Local Studio Nightly.app", "Local Studio Dev.app"];

type Env = Record<string, string | undefined>;
export type SkillsTool = "skill_search" | "skill_read";
export type SkillsAnswer = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function macApps(platform: NodeJS.Platform): string[] {
	if (platform !== "darwin") return [];
	return ["/", homedir()].flatMap((root) => MAC_APPS.map((app) => join(root, "Applications", app, "Contents", "MacOS")));
}

/** A Mac app from before it carried its command line tool. */
const oldApp = (platform: NodeJS.Platform): boolean => macApps(platform).some((folder) => existsSync(join(folder, "LocalStudio")));

/** What skill_search answers when there is no tool to ask. */
export const noSkills = (platform: NodeJS.Platform = process.platform): string => (oldApp(platform) ? OLD_APP : NO_SKILLS);

/** Local Studio's command line tool: LOCAL_STUDIO_CLI_BIN, else in the app this program is part of, on PATH, in ~/.local/bin or in the Mac app. */
export function skillsCommand(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	if (env.LOCAL_STUDIO_CLI_BIN) return existsSync(env.LOCAL_STUDIO_CLI_BIN) ? env.LOCAL_STUDIO_CLI_BIN : undefined;
	// In the app, this program is in browser/ beside the tool (Linux, or lib/local-studio/browser under its bin) or in Resources.
	const beside = dirname(selfExec());
	const folders = [...(COMPILED ? [beside, join(beside, ".."), join(beside, "..", "..", "MacOS"), join(beside, "..", "..", "..", "bin")] : []), ...(env.PATH ?? "").split(delimiter).filter(isAbsolute)];
	const own = process.platform === "win32" ? [] : [join(homedir(), ".local", "bin")];
	return [...folders, ...own, ...macApps(platform)].flatMap((folder) => NAMES.map((name) => join(folder, name))).find(existsSync);
}

/** The folders the store reads from, and nothing else of this process's environment. */
function skillsEnv(env: Env): Record<string, string> {
	const wanted = Object.entries(env).filter(([name, value]) => value && /^(LOCAL_STUDIO_(DATA|SKILLS)_DIR|EUKHE_CODING_AGENT_DIR|XDG_\w+_HOME)$/.test(name));
	return { ...getDefaultEnvironment(), ...(Object.fromEntries(wanted) as Record<string, string>) };
}

export class Skills {
	private client?: Promise<Client>;

	/** A remote or scoped session passes `shipped`: only the skills that come with the app, never the person's own. */
	constructor(
		private readonly shipped: boolean,
		private readonly env: Env = process.env,
		private readonly answerMs = ANSWER_MS,
	) {}

	async call(tool: SkillsTool, args: Record<string, unknown>): Promise<SkillsAnswer> {
		const command = skillsCommand(this.env);
		if (!command) return { content: [{ type: "text", text: noSkills() }] };
		try {
			const client = await this.open(command);
			return (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.answerMs })) as SkillsAnswer;
		} catch {
			await this.close();
			return { content: [{ type: "text", text: SKILLS_SILENT }], isError: true };
		}
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		await (await client?.catch(() => undefined))?.close().catch(() => undefined);
	}

	private open(command: string): Promise<Client> {
		if (this.client) return this.client;
		const client = new Client({ name: "local-studio-browser", version: "1" });
		const opened = client
			.connect(
				new StdioClientTransport({ command, args: ["skills", "mcp", ...(this.shipped ? ["--shipped"] : [])], env: skillsEnv(this.env), stderr: "ignore" }),
				{ timeout: this.answerMs },
			)
			.then(() => client);
		client.onclose = () => {
			if (this.client === opened) this.client = undefined;
		};
		this.client = opened;
		return opened;
	}
}
