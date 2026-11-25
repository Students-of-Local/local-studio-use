import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildInfo } from "../../scripts/build-info.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// LOCAL_STUDIO_BROWSER_CLI_OUT_DIR builds elsewhere: the checkout updater builds next to dist and swaps it in
// only when the build succeeded (cli/src/checkout.ts).
const outDir = process.env.LOCAL_STUDIO_BROWSER_CLI_OUT_DIR || join(root, "dist");
// What this build was made from; compared with the extension's (src/update/build.ts).
const info = buildInfo(join(root, ".."));
// LOCAL_STUDIO_BROWSER_CLI_COMPILED=1 makes the bundle that scripts/compile.mjs turns into the single executable inside
// Local Studio: it starts itself and finds the extension next to itself (src/self.ts) rather than through Node.
const compiled = process.env.LOCAL_STUDIO_BROWSER_CLI_COMPILED === "1";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: root,
	entryPoints: { index: join(root, "src/index.ts") },
	bundle: true,
	platform: "node",
	target: ["node20"],
	format: "esm",
	outdir: outDir,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle everything (incl. the MCP SDK and zod) so the CLI is self-contained and runs
	// from a global link or npx without a node_modules next to dist.
	packages: "bundle",
	sourcemap: !compiled,
	// keys/local-studio-release.pub is bundled as text: the key that verifies releases ships inside the CLI. The Local Studio
	// plugins (plugins/, cli/src/local-studio.ts) ship the same way, so every copy of the program can install them.
	loader: { ".pub": "text", ".md": "text", ".toml": "text" },
	define: { __LOCAL_STUDIO_BROWSER_BUILD__: JSON.stringify(info), __LOCAL_STUDIO_BROWSER_COMPILED__: JSON.stringify(compiled) },
	logLevel: "info",
});
chmodSync(join(outDir, "index.js"), 0o755);
writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(info, null, "\t")}\n`);
