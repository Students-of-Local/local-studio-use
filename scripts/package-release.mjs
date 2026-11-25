// Packages a Local Studio release from a built checkout (`npm run build` at the root and in cli/, with LOCAL_STUDIO_BROWSER_NO_BUMP=1):
//   local-studio-browser-<version>-<os>-<arch>.tar.gz (.zip for Windows): the `local-studio-browser` executable (the CLI, MCP server and native
//     host in one, compiled by Bun, cli/scripts/compile.mjs), with extension/ and plugins/ beside it, and for a target
//     named in --hands, the computer-use helper in bin/ (`local-studio-browser install --release` copies it to ~/.local/bin on a Mac)
//   local-studio-browser-<version>-extension.zip: the unpacked extension (dist-chrome), the same folder as extension/ above
//   SHA256SUMS: one line per artifact, what `local-studio-browser install --release` checks
// CI's clean-install job runs it for linux-x64 and installs the result the way a user would.
//   node scripts/package-release.mjs --out <dir> [--targets linux-x64,darwin-arm64,win-x64] [--hands <target>=<file>]...
// --hands takes a built local-studio-computer (hands/mac/scripts/package.sh signs the Mac one) for one target; it may repeat.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const out = arg("--out");
const targets = arg("--targets", "linux-x64,darwin-arm64,win-x64").split(",");
// --hands <target>=<file>, any number of times: the helper each of those targets carries in bin/.
const hands = new Map();
for (let i = 0; i < process.argv.length; i++) {
	if (process.argv[i] !== "--hands") continue;
	const [target, file] = (process.argv[i + 1] ?? "").split(/=(.*)/s);
	if (!targets.includes(target) || !file || !existsSync(file)) {
		console.error(
			`package-release: --hands ${process.argv[i + 1] ?? ""}: name a packaged target and an existing file, as darwin-arm64=<path>`,
		);
		process.exit(2);
	}
	hands.set(target, resolve(file));
}
if (!out) {
	console.error(
		"usage: node scripts/package-release.mjs --out <dir> [--targets linux-x64,darwin-arm64,win-x64] [--hands <target>=<file>]...",
	);
	process.exit(2);
}
const OS = { linux: "linux", darwin: "darwin", win: "windows" };
for (const t of targets) {
	const [os, arch] = t.split("-");
	if (!OS[os] || !["x64", "arm64"].includes(arch)) {
		console.error(`package-release: unknown target ${t} (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64)`);
		process.exit(2);
	}
}

const extension = join(root, "dist-chrome");
if (!existsSync(join(extension, "manifest.json"))) {
	console.error(
		"package-release: dist-chrome/manifest.json is missing. Build first: LOCAL_STUDIO_BROWSER_NO_BUMP=1 npm run build",
	);
	process.exit(1);
}
const version = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8")).version;
const source = JSON.parse(readFileSync(join(root, "static", "manifest.chrome.json"), "utf8")).version;
if (version !== source) {
	console.error(
		`package-release: dist-chrome is ${version} but static/manifest.chrome.json is ${source}. Rebuild with LOCAL_STUDIO_BROWSER_NO_BUMP=1.`,
	);
	process.exit(1);
}

const run = (cmd, args, options = {}) => {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...options });
	if (r.status !== 0) {
		console.error(`package-release: ${cmd} ${args.join(" ")} failed (${r.status ?? r.signal ?? r.error?.message})`);
		process.exit(1);
	}
};
// GNU tar: fixed order and owner, so the same inputs give the same archive bytes.
const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar");
const tarFlags = gnuTar ? ["--sort=name", "--owner=0", "--group=0", "--numeric-owner"] : [];

const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "local-studio-package-"));
const artifacts = [];
try {
	for (const target of targets) {
		const [os, arch] = target.split("-");
		const top = `local-studio-browser-${version}-${target}`;
		const stage = join(work, target, top);
		mkdirSync(stage, { recursive: true });
		const exe = join(stage, os === "win" ? "local-studio-browser.exe" : "local-studio-browser");
		const bundle = join(work, target, "bundle");
		run(
			process.execPath,
			[join(root, "cli", "scripts", "compile.mjs"), "--os", OS[os], "--arch", arch, "--out", exe, "--work", bundle],
			{ cwd: join(root, "cli") },
		);
		copyFileSync(join(bundle, "build-info.json"), join(stage, "build-info.json"));
		cpSync(extension, join(stage, "extension"), { recursive: true });
		cpSync(join(root, "plugins"), join(stage, "plugins"), { recursive: true });
		copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
		if (hands.has(target)) {
			// The helper as it was signed: copyFileSync keeps the bytes, so the signature stays valid.
			mkdirSync(join(stage, "bin"));
			const helper = join(stage, "bin", os === "win" ? "local-studio-computer.exe" : "local-studio-computer");
			copyFileSync(hands.get(target), helper);
			chmodSync(helper, 0o755);
		}
		const name = os === "win" ? `${top}.zip` : `${top}.tar.gz`;
		rmSync(join(outDir, name), { force: true });
		if (os === "win") run("zip", ["-qrX", join(outDir, name), top], { cwd: join(work, target) });
		else
			run("tar", [...tarFlags, "-czf", join(outDir, name), "-C", join(work, target), top], {
				env: { ...process.env, GZIP: "-n" },
			});
		artifacts.push(name);
	}
	const extZip = `local-studio-browser-${version}-extension.zip`;
	rmSync(join(outDir, extZip), { force: true });
	run("zip", ["-qrX", join(outDir, extZip), "."], { cwd: extension });
	artifacts.push(extZip);
} finally {
	rmSync(work, { recursive: true, force: true });
}

const sums = artifacts
	.sort()
	.map(
		(name) =>
			`${createHash("sha256")
				.update(readFileSync(join(outDir, name)))
				.digest("hex")}  ${name}\n`,
	)
	.join("");
writeFileSync(join(outDir, "SHA256SUMS"), sums);
console.log(`package-release: ${version} in ${outDir}`);
for (const f of readdirSync(outDir).sort()) console.log(`  ${f}`);
