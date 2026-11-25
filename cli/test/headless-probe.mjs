// One headless smoke run: the built extension (dist-chrome) loaded into a throwaway Chromium profile with
// --load-extension, the native host it spawns, and the MCP server driven by a real MCP client making one call.
// It shares cli/test/e2e-harness.mjs, so it has its own HOME, profile and socket folder and never touches an
// installed browser or a running bridge. docs/LINUX.md records its output.
//
//   npm run build && (cd cli && npm run build)
//   node cli/test/headless-probe.mjs
//   TABKYRA_E2E_CHROMIUM=/path/to/helium node cli/test/headless-probe.mjs   # another Chromium
import { startHarness } from "./e2e-harness.mjs";

const h = await startHarness();
try {
	const server = h.mcp.getServerVersion();
	console.log(`platform: ${process.platform} ${process.arch}`);
	console.log(`browser: ${process.env.TABKYRA_E2E_CHROMIUM || "Playwright Chromium"}`);
	console.log(`mcp server: ${server?.name} ${server?.version}`);
	const tools = await h.mcp.listTools();
	console.log(`mcp tools: ${tools.tools.length}`);
	const url = h.mount("probe", "<!doctype html><title>Probe</title><h1>Hello from the probe page</h1>");
	const nav = await h.go(url);
	console.log(`navigate: ${nav.split("\n")[0]}`);
	const text = await h.tool("get_page_text", {});
	console.log(`get_page_text has heading: ${text.includes("Hello from the probe page")}`);
	if (!text.includes("Hello from the probe page")) {
		console.log(`get_page_text said: ${text.slice(0, 300)}`);
		process.exitCode = 1;
	}
} finally {
	await h.stop();
}
