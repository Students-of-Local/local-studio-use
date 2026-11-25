// Stamps the release version into the Local Studio plugins: each plugins/*/plugin.toml `version` and each skill's
// `version:` frontmatter line. The extension manifest is where a version is set (the build's bump); this
// keeps the plugins in step with it, and cli/test/local-studio-plugins.test.mjs fails when they drift.
//   node scripts/plugin-version.mjs [version]   (default: static/manifest.chrome.json's)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rewrite the version lines; returns the files that changed. */
export function stampPluginVersions(version, repo = root) {
	const changed = [];
	const plugins = join(repo, "plugins");
	if (!existsSync(plugins)) return changed;
	const write = (file, from, to) => {
		const text = readFileSync(file, "utf8");
		const next = text.replace(from, to);
		if (next === text && !from.test(text)) throw new Error(`${file}: no version line to stamp`);
		if (next !== text) {
			writeFileSync(file, next);
			changed.push(file);
		}
	};
	for (const id of readdirSync(plugins)) {
		const toml = join(plugins, id, "plugin.toml");
		if (!existsSync(toml)) continue;
		write(toml, /^version = ".*"$/m, `version = "${version}"`);
		const skills = join(plugins, id, "skills");
		if (!existsSync(skills)) continue;
		for (const skill of readdirSync(skills)) {
			const file = join(skills, skill, "SKILL.md");
			if (existsSync(file)) write(file, /^version: .*$/m, `version: ${version}`);
		}
	}
	return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const version =
		process.argv[2] ?? JSON.parse(readFileSync(join(root, "static", "manifest.chrome.json"), "utf8")).version;
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		console.error(`plugin-version: "${version}" is not a release version`);
		process.exit(2);
	}
	for (const file of stampPluginVersions(version)) console.log(`plugin-version: ${file} -> ${version}`);
}
