// What the Chrome Web Store zip may hold. `prepare` strips a build folder and `check` fails on anything
// left over. test/store-package.test.mjs runs the same functions, and test/store-zip.test.mjs runs them on a real build.
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importMap, libraryProblems, packSandboxLibraries } from "./sandbox-libraries.mjs";

/** This checkout: where the library list is read from when no source root is given. */
const here = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The store listing's name; the zip's manifest must say the same. */
export const STORE_NAME = "Local Studio";

/**
 * The CDNs the release build's sandbox may load code from. No file in the store zip may name one: the store build loads
 * no code from outside its package, and its prompts must not tell the agent it can.
 */
export const CDN_HOSTS = [
	"cdn.jsdelivr.net",
	"unpkg.com",
	"cdnjs.cloudflare.com",
	"esm.sh",
	"esm.run",
	"cdn.skypack.dev",
	"cdn.tailwindcss.com",
];

/**
 * img-src keeps `https:`: the agent's HTML artifacts and REPL output show pictures from the pages it reads, and an image
 * is not code. Every other directive may name only the package itself.
 */
const MAY_BE_REMOTE = new Set(["img-src"]);

/** A source that names something outside the package: a scheme like https:, a host, or a wildcard. */
const isRemoteSource = (source) => !/^'[^']*'$/.test(source) && source !== "data:" && source !== "blob:";

/** Each directive of a content security policy, with its sources. */
const directives = (csp) =>
	csp
		.split(";")
		.map((d) => d.trim().split(/\s+/))
		.filter((d) => d[0]);

/** "<directive> <source>" for every remote source a policy allows outside img-src. */
export function remoteSources(csp) {
	const found = [];
	for (const [name, ...sources] of directives(csp)) {
		if (name === "sandbox" || MAY_BE_REMOTE.has(name)) continue;
		for (const s of sources) if (isRemoteSource(s)) found.push(`${name} ${s}`);
	}
	return found;
}

/** The release sandbox policy with every remote source taken out (img-src aside), and directives left empty dropped. */
export function storeSandboxCsp(csp) {
	return directives(csp)
		.map(([name, ...sources]) => {
			if (name === "sandbox" || MAY_BE_REMOTE.has(name)) return [name, ...sources];
			const kept = sources.filter((s) => !isRemoteSource(s));
			// An empty list would mean "nothing" only if written as 'none'; dropping it falls back to default-src 'none'.
			return kept.length ? [name, ...kept] : undefined;
		})
		.filter(Boolean)
		.map((d) => d.join(" "))
		.join("; ");
}

const NOTICE = `Local Studio browser extension. AGPL-3.0: see LICENSE.
Source: https://github.com/baney75/local-studio/tree/main/browser
Built on 0xSero's agent bridge (https://github.com/0xSero/sitegeist) and Mario Zechner's Sitegeist
(https://github.com/badlogic/sitegeist).
`;

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

const isStripped = (rel) => rel.endsWith(".map") || /^debug\.(html|js)$/.test(rel);

export function prepare(folder, sourceRoot) {
	for (const path of [...walk(folder)]) if (isStripped(relative(folder, path))) rmSync(path);
	const manifestPath = join(folder, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	delete manifest.key;
	const csp = manifest.content_security_policy;
	if (csp?.sandbox) csp.sandbox = storeSandboxCsp(csp.sandbox);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	copyFileSync(join(sourceRoot, "LICENSE"), join(folder, "LICENSE"));
	writeFileSync(join(folder, "NOTICE"), NOTICE);
	// The libraries the store prompt names, in the package, and the import map that lets the sandbox's code import them
	// by name. The map stays in effect after sandbox.js replaces the page with document.write: it belongs to the window.
	packSandboxLibraries(folder, sourceRoot);
	const sandboxPath = join(folder, "sandbox.html");
	const sandbox = readFileSync(sandboxPath, "utf8");
	const loader = '<script src="sandbox.js"></script>';
	if (!sandbox.includes(loader)) throw new Error(`sandbox.html no longer loads sandbox.js as ${loader}`);
	const map = `<script type="importmap">${JSON.stringify(importMap(sourceRoot))}</script>`;
	writeFileSync(sandboxPath, sandbox.replace(loader, `${map}\n    ${loader}`));
}

/** The permissions store/permissions.md gives a reason for: the first cell of each table row, in backticks. */
export function explainedPermissions(doc) {
	return [...doc.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
}

/** What the manifest asks for, permissions, optional ones and hosts alike. */
export function askedPermissions(manifest) {
	return [
		...(manifest.permissions ?? []),
		...(manifest.optional_permissions ?? []),
		...(manifest.host_permissions ?? []),
		...(manifest.optional_host_permissions ?? []),
	];
}

/**
 * Every problem with a prepared folder; empty when the store may have it. With the source root it also checks the
 * version against package.json and every permission against store/permissions.md, both ways.
 */
export function problems(folder, sourceRoot) {
	const found = [];
	for (const path of walk(folder)) {
		const rel = relative(folder, path);
		if (isStripped(rel)) found.push(`${rel} must not ship`);
		if (rel.endsWith(".pem")) found.push(`${rel} is a key file`);
		if (rel.endsWith(".html") && /debug\.js/.test(readFileSync(path, "utf8")))
			found.push(`${rel} loads the debug page`);
		if (/\.(html|js|mjs|json|css)$/.test(rel)) {
			const text = readFileSync(path, "utf8");
			for (const host of CDN_HOSTS) if (text.includes(host)) found.push(`${rel} names the CDN ${host}`);
		}
	}
	const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
	for (const [page, csp] of Object.entries(manifest.content_security_policy ?? {}))
		for (const source of remoteSources(csp)) found.push(`the ${page} content security policy allows ${source}`);
	for (const p of libraryProblems(folder, sourceRoot ?? here)) found.push(p);
	if ("key" in manifest) found.push("manifest has a key");
	if ("update_url" in manifest) found.push("manifest has an update_url");
	if (manifest.name !== STORE_NAME) found.push(`manifest name is "${manifest.name}", not "${STORE_NAME}"`);
	if (manifest.description.length > 132) found.push("description is over the store limit of 132 characters");
	const icons = {
		...manifest.icons,
		...(typeof manifest.action?.default_icon === "object" ? manifest.action.default_icon : {}),
	};
	if (!manifest.icons?.["128"]) found.push("manifest has no 128 px icon");
	for (const icon of new Set(Object.values(icons)))
		if (!existsSync(join(folder, icon))) found.push(`icon ${icon} is missing`);
	if (sourceRoot) {
		const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
		if (manifest.version !== pkg.version)
			found.push(`manifest version ${manifest.version} is not package.json's ${pkg.version}`);
		const explained = explainedPermissions(readFileSync(join(sourceRoot, "store/permissions.md"), "utf8"));
		const asked = askedPermissions(manifest);
		for (const p of asked)
			if (!explained.includes(p)) found.push(`permission ${p} has no reason in store/permissions.md`);
		for (const p of explained)
			if (!asked.includes(p)) found.push(`store/permissions.md explains ${p}, which the manifest does not ask for`);
	}
	for (const file of ["LICENSE", "NOTICE"]) if (!existsSync(join(folder, file))) found.push(`${file} is missing`);
	return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [, , command, folder, sourceRoot] = process.argv;
	if (command === "prepare") prepare(folder, sourceRoot);
	else if (command === "check") {
		const found = problems(folder, sourceRoot);
		for (const p of found) console.error(p);
		if (found.length) process.exit(1);
	} else {
		console.error("usage: store-package.mjs prepare <folder> <source root> | check <folder> [source root]");
		process.exit(2);
	}
}
