// microsoft/playwright-mcp from npm: its own headless Chromium, isolated (in-memory) profile.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { TOOLS } from "../tools.mjs";
import { connectMcp } from "../mcp.mjs";

const cli = join(TOOLS, "pw/node_modules/@playwright/mcp/cli.js");

export default {
	name: "playwright-mcp",
	async start() {
		const out = mkdtempSync(join(process.env.TMPDIR || "/tmp", "pw-out-"));
		const mcp = await connectMcp({ command: process.execPath, args: [cli, "--headless", "--isolated", "--browser", "chromium", "--executable-path", process.env.MARKET_CHROMIUM || chromium.executablePath(), "--output-dir", out] });
		return { mcp, call: mcp.call, out };
	},
	async stop(ctx) {
		await ctx.mcp.call("browser_close", {}).catch(() => {});
		await ctx.mcp.close().catch(() => {});
		rmSync(ctx.out, { recursive: true, force: true });
	},
};
