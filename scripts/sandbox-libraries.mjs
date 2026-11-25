// The libraries the store build packs for sandbox.html, where the agent's REPL code and HTML artifacts run. The release
// build lets that code import any package from a CDN; the store build may load no code from outside its zip, so it ships
// the libraries the prompt names (src/prompts/sandbox-libraries.json) under sandbox-lib/ and maps their names to those
// files with an import map. scripts/store-package.mjs calls these from `prepare` and `check`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** The folder in the extension the libraries are written to, and the URL path they load from. */
export const LIBRARY_DIR = "sandbox-lib";
export const NOTICES_FILE = "THIRD_PARTY_NOTICES";

/**
 * Licenses that may ship in an AGPL-3.0 extension: permissive ones, all compatible with it. A bundled package under any
 * other license fails the build until someone checks it and adds it here.
 */
export const ALLOWED_LICENSES = new Set([
	"MIT",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	"0BSD",
	"Zlib",
	"(MIT AND Zlib)",
	"(MIT OR GPL-3.0-or-later)",
]);

export function sandboxLibraries(sourceRoot) {
	return JSON.parse(readFileSync(join(sourceRoot, "src/prompts/sandbox-libraries.json"), "utf8"));
}

/** The import map sandbox.html carries: each module's name to its file in the package. */
export function importMap(sourceRoot) {
	const imports = {};
	for (const m of sandboxLibraries(sourceRoot).modules) imports[m.specifier] = `/${LIBRARY_DIR}/${m.file}`;
	return { imports };
}

/** Every file the import map and the scripts list name, relative to the extension folder. */
export function libraryFiles(sourceRoot) {
	const { modules, scripts } = sandboxLibraries(sourceRoot);
	return [...modules, ...scripts].map((l) => `${LIBRARY_DIR}/${l.file}`);
}

function packageDir(sourceRoot, name) {
	return join(sourceRoot, "node_modules", name);
}

function licenseText(dir) {
	const file = readdirSync(dir).find((n) => /^licen[cs]e(\.(md|txt))?$/i.test(n));
	return file ? readFileSync(join(dir, file), "utf8").trim() : undefined;
}

/**
 * Bundles the modules and copies the scripts into <folder>/sandbox-lib, and writes <folder>/THIRD_PARTY_NOTICES with
 * the license of every package that ended up in them. Fails when an installed version is not the pinned one, or when a
 * bundled package has no license file or one not in ALLOWED_LICENSES.
 */
export function packSandboxLibraries(folder, sourceRoot) {
	const require = createRequire(join(sourceRoot, "package.json"));
	const { buildSync } = require("esbuild");
	const { modules, scripts } = sandboxLibraries(sourceRoot);
	for (const lib of [...modules, ...scripts]) {
		const installed = JSON.parse(
			readFileSync(join(packageDir(sourceRoot, lib.package), "package.json"), "utf8"),
		).version;
		if (installed !== lib.version)
			throw new Error(`${lib.package} is ${installed} in node_modules, not the pinned ${lib.version}; run npm ci`);
	}
	const out = join(folder, LIBRARY_DIR);
	mkdirSync(out, { recursive: true });
	const result = buildSync({
		absWorkingDir: sourceRoot,
		entryPoints: modules.map((m) => ({ in: m.specifier, out: m.file.replace(/\.js$/, "") })),
		bundle: true,
		format: "esm",
		// Modules that share code (chart.js and chart.js/auto) share one chunk instead of each carrying a copy.
		splitting: true,
		chunkNames: "chunk-[hash]",
		minify: true,
		platform: "browser",
		target: ["chrome120"],
		outdir: out,
		metafile: true,
		logLevel: "warning",
	});
	// Each package folder that code was bundled from, nested ones (docx/node_modules/nanoid) included.
	const dirs = new Set();
	for (const input of Object.keys(result.metafile.inputs)) {
		const dir = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
		if (dir) dirs.add(join(sourceRoot, dir));
	}
	for (const s of scripts) {
		copyFileSync(join(packageDir(sourceRoot, s.package), s.source), join(out, s.file));
		dirs.add(packageDir(sourceRoot, s.package));
	}
	// A package that ships a prebuilt bundle (docx inlines fflate and nanoid) hides its dependencies from the metafile, so
	// every runtime dependency of a bundled package is credited too, found where Node would find it.
	for (const dir of dirs) {
		const { dependencies = {} } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		for (const dep of Object.keys(dependencies)) {
			if (dep.startsWith("@types/")) continue;
			const found = [join(dir, "node_modules", dep), packageDir(sourceRoot, dep)].find((d) => existsSync(d));
			if (!found) throw new Error(`${dir} depends on ${dep}, which is not installed`);
			dirs.add(found);
		}
	}
	const packages = new Set();
	const sections = [];
	for (const dir of [...dirs].sort()) {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const name = pkg.name;
		if (packages.has(`${name}@${pkg.version}`)) continue;
		packages.add(`${name}@${pkg.version}`);
		if (!ALLOWED_LICENSES.has(pkg.license))
			throw new Error(
				`${name} is licensed "${pkg.license}", which is not in ALLOWED_LICENSES (scripts/sandbox-libraries.mjs)`,
			);
		const text = licenseText(dir);
		if (!text) throw new Error(`${name} has no license file to ship in ${NOTICES_FILE}`);
		sections.push(`${name} ${pkg.version} (${pkg.license})\n${pkg.homepage ?? ""}\n\n${text}\n`);
	}
	writeFileSync(
		join(folder, NOTICES_FILE),
		`Third-party libraries in ${LIBRARY_DIR}/, which code in the sandboxed page (sandbox.html) can import.\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`,
	);
	return [...packages].sort();
}

/** What is wrong with a folder's packed libraries: missing files, a missing notices file, or a missing import map. */
export function libraryProblems(folder, sourceRoot) {
	const found = [];
	for (const file of libraryFiles(sourceRoot)) if (!existsSync(join(folder, file))) found.push(`${file} is missing`);
	if (!existsSync(join(folder, NOTICES_FILE))) found.push(`${NOTICES_FILE} is missing`);
	const sandbox = join(folder, "sandbox.html");
	if (!existsSync(sandbox)) found.push("sandbox.html is missing");
	else {
		const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(readFileSync(sandbox, "utf8"))?.[1];
		if (!map) found.push("sandbox.html has no import map");
		else if (JSON.stringify(JSON.parse(map)) !== JSON.stringify(importMap(sourceRoot)))
			found.push("sandbox.html's import map is not the one src/prompts/sandbox-libraries.json gives");
	}
	return found;
}
