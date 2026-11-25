// anomalyco/browse: Rust relay + Chromium extension, driven over its MCP server. Throwaway profile and relay home.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionIdFromKey, launchChromium, sleep, until } from "../chromium.mjs";
import { TOOLS } from "../tools.mjs";
import { connectMcp } from "../mcp.mjs";

const ROOT = join(TOOLS, "browse");
const bin = join(ROOT, "rust/target/debug/browse");
const extDir = join(ROOT, "dist");

export default {
	name: "browse",
	async start({ fixtures, mode }) {
		const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "browse-home-"));
		const env = {
			...process.env,
			OPENCODE_BROWSER_HOME: home,
			OPENCODE_BROWSER_AUTO_UPDATE: "off",
			OPENCODE_BROWSER_FILE_ROOTS: fixtures,
			// Plain tools for scripted solves; the default surface (execute + status + tabs) for model runs.
			OPENCODE_BROWSER_TOOLS: process.env.BROWSE_TOOLS || (mode === "model" ? "execute" : "plain"),
			OPENCODE_BROWSER_HUMAN_INPUT: process.env.BROWSE_HUMAN_INPUT ?? "1",
		};
		const chrome = await launchChromium({ extension: extDir });
		const extId = await extensionIdFromKey(JSON.parse(readFileSync(join(extDir, "manifest.json"))).key);
		await until(async () => (await chrome.targets()).find((t) => t.url.startsWith(`chrome-extension://${extId}/`)), 15000, "browse service worker");
		const r = spawnSync(bin, ["pair", "--wait-seconds", "1"], { env, encoding: "utf8", timeout: 30000 });
		const code = /([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(r.stdout + r.stderr)?.[1];
		if (!code) throw new Error(`browse pair printed no code: ${r.stdout}${r.stderr}`);
		await chrome.send("Target.createTarget", { url: `chrome-extension://${extId}/settings.html` });
		await sleep(1000);
		const pairJs = `(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
 for (let i = 0; i < 100; i++) { const form = document.querySelector("form.relay-form"); if (form) { const inp = [...form.querySelectorAll("input")].find((x) => x.placeholder === "XXXX-XXXX"); setter.call(inp, ${JSON.stringify(code)}); inp.dispatchEvent(new Event("input", { bubbles: true })); form.requestSubmit(); return "submitted"; }
 await new Promise((r) => setTimeout(r, 100)); } return "no form"; })()`;
		await chrome.evaluate(pairJs, `chrome-extension://${extId}/settings.html`);
		await until(() => JSON.parse(execFileSync(bin, ["status", "--json"], { env, encoding: "utf8" })).extension?.connected, 40000, "browse to connect");
		const mcp = await connectMcp({ command: bin, args: ["mcp"], env });
		return { chrome, mcp, env, home, call: mcp.call };
	},
	async stop(ctx) {
		await ctx.mcp?.close().catch(() => {});
		spawnSync("pkill", ["-f", `[${ctx.home[0]}]${ctx.home.slice(1)}`]);
		// The relay outlives its client. Find it by the throwaway home in its environment: /proc on Linux, `ps -E` on macOS.
		// A relay left behind holds the port with another token, and the next run's client gets 401.
		const envOf = process.platform === "linux" ? `tr '\\0' '\\n' < /proc/$p/environ` : `ps -Eww -o command= -p $p`;
		spawnSync("sh", ["-c", `for p in $(pgrep -f '[d]ebug/browse serve'); do ${envOf} | grep -q 'OPENCODE_BROWSER_HOME=${ctx.home}' && kill $p; done`]);
		await ctx.chrome?.stop();
	},
	async between() {},
	solves: {},
};
