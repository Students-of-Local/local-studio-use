// ChromeDevTools/chrome-devtools-mcp from npm: its own headless Chromium in a temporary profile (--isolated), no usage
// statistics. The task fixtures are its file root, so upload_file may read them.
import { join } from "node:path";
import { chromium } from "playwright-core";
import { TOOLS } from "../tools.mjs";
import { connectMcp } from "../mcp.mjs";

const cli = join(TOOLS, "cdt/node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js");

export default {
	name: "chrome-devtools-mcp",
	async start({ fixtures }) {
		const args = [cli, "--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux", "--executablePath", process.env.MARKET_CHROMIUM || chromium.executablePath(), "--workspace", fixtures];
		const mcp = await connectMcp({ command: process.execPath, args, env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" } });
		return { mcp, call: mcp.call };
	},
	async stop(ctx) {
		await ctx.mcp.close().catch(() => {});
	},
};
