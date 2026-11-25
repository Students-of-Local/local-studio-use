// vercel-labs/agent-browser: Rust CLI + per-session daemon over CDP, driven by its CLI (its primary interface; its MCP
// server has no upload or dialog tool). Own HOME and session; Playwright's Chromium instead of a Chrome for Testing download.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { TOOLS } from "../tools.mjs";
import { connectMcp } from "../mcp.mjs";

const bin = join(TOOLS, "ab/node_modules/.bin/agent-browser");

export default {
	name: "agent-browser",
	async start({ mode }) {
		const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "ab-home-"));
		const env = {
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			AGENT_BROWSER_EXECUTABLE_PATH: process.env.MARKET_CHROMIUM || chromium.executablePath(),
			AGENT_BROWSER_SESSION: `study-${process.pid}`,
			AGENT_BROWSER_NO_XVFB: "1",
		};
		const ctx = { bin, env, home };
		if (mode === "model") {
			ctx.mcp = await connectMcp({ command: bin, args: ["mcp"], env });
			ctx.call = ctx.mcp.call;
		}
		return ctx;
	},
	async stop(ctx) {
		await ctx.mcp?.close().catch(() => {});
		try {
			execFileSync(bin, ["close", "--all"], { env: { ...process.env, ...ctx.env }, timeout: 20000 });
		} catch {}
		rmSync(ctx.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	},
};
