// The Local Studio plugins in plugins/: each plugin.toml follows the rules of Local Studio's loader
// (core/src/plugins.rs at e9d1a6980; scripts/validate-local-studio-plugins.sh runs the loader itself), and the
// plugin and every skill in it carry the release version, the one `local-studio-browser --version` prints.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const plugins = join(here, "..", "..", "plugins");
const VERSION = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
const ids = ["browser-use", "computer-use"];

/** The TOML this manifest uses: `key = "string"`, `key = []` and `[[commands]]` tables. Anything else fails. */
function parseManifest(text) {
	const top = {};
	let table = top;
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		if (line === "[[commands]]") {
			top.commands ??= [];
			table = {};
			top.commands.push(table);
			continue;
		}
		const m = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
		assert.ok(m, `line ${i + 1}: not key = value: ${raw}`);
		const [, key, value] = m;
		assert.ok(!(key in table), `line ${i + 1}: ${key} twice`);
		if (value === "[]") table[key] = [];
		else {
			assert.match(value, /^"[^"\\]*"$/, `line ${i + 1}: ${key} must be a plain string or []`);
			table[key] = value.slice(1, -1);
		}
	}
	return top;
}

function frontmatter(text, key) {
	const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!body.startsWith("---\n")) return undefined;
	const end = body.indexOf("\n---", 4);
	if (end < 0) return undefined;
	for (const line of body.slice(4, end).split("\n")) {
		if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
	}
	return undefined;
}

const semver = (v) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(v);
const inside = (p) => !p.startsWith("/") && !p.split("/").some((part) => part === ".." || part === "");

for (const id of ids) {
	const dir = join(plugins, id);
	test(`${id}: plugin.toml loads under Local Studio's rules`, () => {
		const m = parseManifest(readFileSync(join(dir, "plugin.toml"), "utf8"));
		const allowed = new Set(["id", "version", "description", "skills", "prompts", "commands", "capabilities"]);
		for (const key of Object.keys(m)) assert.ok(allowed.has(key), `unknown field ${key} (deny_unknown_fields)`);
		for (const key of ["id", "version", "description"]) assert.equal(typeof m[key], "string", `${key} is required`);
		assert.match(m.id, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
		assert.equal(m.id, id, "the id must equal the folder name");
		assert.ok(semver(m.version), `bad version ${m.version}`);
		assert.ok(m.description.trim());
		// Any capability fails the load today ("capability not supported yet").
		assert.deepEqual(m.capabilities ?? [], []);
		const skillsDir = join(dir, m.skills ?? "skills");
		if (m.skills !== undefined) assert.ok(inside(m.skills) && statSync(skillsDir).isDirectory(), "missing skills dir");
		if (m.prompts !== undefined) assert.ok(inside(m.prompts) && statSync(join(dir, m.prompts)).isDirectory(), "missing prompts dir");
		const skills = readdirSync(skillsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => {
				const file = join(skillsDir, e.name, "SKILL.md");
				assert.ok(existsSync(file), `missing skill file ${file}`);
				return frontmatter(readFileSync(file, "utf8"), "name") ?? e.name;
			});
		assert.ok(skills.length > 0);
		const names = new Set();
		for (const c of m.commands ?? []) {
			for (const key of Object.keys(c)) assert.ok(["name", "description", "prompt", "skill"].includes(key), `unknown command field ${key}`);
			assert.match(c.name, /^[A-Za-z0-9_:.-]+$/);
			assert.ok(!c.name.startsWith("skill:"));
			assert.ok(!names.has(c.name), `duplicate command ${c.name}`);
			names.add(c.name);
			assert.equal(typeof c.description, "string");
			assert.ok((c.prompt === undefined) !== (c.skill === undefined), `command ${c.name}: set exactly one of prompt or skill`);
			if (c.skill !== undefined) assert.ok(skills.includes(c.skill), `command ${c.name}: missing skill ${c.skill}`);
			else assert.ok(inside(c.prompt) && statSync(join(dir, c.prompt)).isFile(), `command ${c.name}: missing prompt ${c.prompt}`);
		}
		assert.ok(names.size > 0, "a slash command");
	});

	test(`${id}: the plugin and its skills carry the CLI's version`, () => {
		const m = parseManifest(readFileSync(join(dir, "plugin.toml"), "utf8"));
		assert.equal(m.version, VERSION, "plugin.toml version (scripts/plugin-version.mjs keeps it in step)");
		const skillsDir = join(dir, m.skills ?? "skills");
		for (const skill of readdirSync(skillsDir)) {
			const text = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
			assert.equal(frontmatter(text, "version"), VERSION, `${skill}/SKILL.md version`);
		}
	});
}
