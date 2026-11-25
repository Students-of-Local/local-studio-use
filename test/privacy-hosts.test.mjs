// PRIVACY.md names every host this code can contact, and no other. The scan reads every hard-coded http(s) or ws(s) host
// in src/, cli/src/, hands/ and static/ (tests and comment lines skipped). A host passes one of two ways:
//   1. PRIVACY.md names it in backticks, `models.dev`, which is the fix when the code contacts it; or
//   2. NOT_CONTACTED lists it with the files that may mention it and why nothing is fetched there.
// An exempt host in a new file is checked again; a new URL on it in a listed file is not.
// The scan can't see a host a library, a redirect or another program supplies, so OTHER_HOSTS lists those by hand, nor one
// built from pieces or written as a number.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = readFileSync(join(root, "PRIVACY.md"), "utf8");

const PROMPT_EXAMPLE = "an example site in text the model reads; pages open only when the agent navigates";
const LINK = "a link or a hint the user follows, or an address only compared against";

/** host -> [why nothing is fetched there, the files that may mention it]. */
const NOT_CONTACTED = new Map([
	["arxiv.org", ["names a file the agent asked for; the host is only compared against", ["src/tools/extract-document.ts"]]],
	["calendar.google.com", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
	["chatgpt.com", [LINK, ["src/subscriptions/constants.ts", "cli/src/oauth.ts"]]],
	["chrome.google.com", [LINK, ["src/browser/cdp.ts", "src/recording/recorder.ts"]]],
	["chromewebstore.google.com", [LINK, ["src/browser/cdp.ts"]]],
	["claude.ai", ["a sign-in redirect the browser follows", ["cli/src/oauth.ts"]]],
	["claude.com", ["a sign-in redirect the browser follows", ["cli/src/oauth.ts"]]],
	["dash.cloudflare.com", [LINK, ["cli/src/relay-setup.ts"]]],
	["developers.cloudflare.com", [LINK, ["cli/src/remote-state.ts"]]],
	["developers.openai.com", [LINK, ["src/subscriptions/constants.ts"]]],
	["docs.github.com", [LINK, ["src/subscriptions/constants.ts"]]],
	["docs.google.com", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
	["news.ycombinator.com", [PROMPT_EXAMPLE, ["cli/src/mcp.ts"]]],
	["nodejs.org", [LINK, ["cli/src/doctor.ts", "cli/src/remote-state.ts"]]],
	["schemas.microsoft.com", ["an XML namespace", ["cli/src/service.ts"]]],
	["schemas.openxmlformats.org", ["an XML namespace", ["src/artifacts/preview/pptx.ts"]]],
	["site.com", [PROMPT_EXAMPLE, ["src/prompts/prompts.ts"]]],
	["store.com", [PROMPT_EXAMPLE, ["src/prompts/prompts.ts"]]],
	["tailscale.com", [LINK, ["cli/src/remote-state.ts"]]],
	["www.apple.com", ["an XML document type", ["cli/src/service.ts"]]],
	["www.derstandard.at", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
	["www.google.com", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
	["www.freedesktop.org", ["an XML document type", ["hands/linux/src/engine.rs"]]],
	["www.linkedin.com", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
	["www.w3.org", ["an XML namespace", [
		"src/app.css",
		"src/artifacts/TkFileArtifact.ts",
		"src/artifacts/TkImageArtifact.ts",
		"src/artifacts/preview/slide-render.ts",
		"src/browser/veil-page.ts",
		"src/components/local-studio-svg.ts",
	]]],
	["www.youtube.com", [PROMPT_EXAMPLE, ["src/tools/default-skills.ts"]]],
]);

/** Hosts a library, a redirect or another program supplies, so no literal shows them: why, and the file that causes it. */
const OTHER_HOSTS = new Map([
	["api.githubcopilot.com", ["the Copilot kit's own address, read in its 1.0.28 runtime", "cli/src/subscriptions/copilot.ts"]],
	["huggingface.co", ["@huggingface/transformers' default", "src/dictation/worker.ts"]],
	["registry.npmjs.org", ["npm's default", "cli/src/subscriptions/install-sdk.ts"]],
	["release-assets.githubusercontent.com", ["where github.com sends a release download", "cli/src/update.ts"]],
	["us.aws.cdn.hf.co", ["where huggingface.co sends a model download", "src/dictation/worker.ts"]],
]);

/** Files that only write about a host, so naming one there is no sign it is still contacted. */
const DESCRIBES = new Set(["src/dialogs/PrivacyTab.ts", "src/prompts/prompts.ts"]);

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (name === "node_modules" || name === "dist") continue;
		if (statSync(path).isDirectory()) yield* files(path);
		else if (/\.(ts|js|mjs|json|html|css|rs|swift)$/.test(name) && !/\.test\./.test(name)) yield path;
	}
}

/** Reserved documentation names (RFC 2606) reach no one. */
const RESERVED = /(^|\.)example\.(com|org|net)$|\.(example|invalid|test|localhost)$/;

/** The hosts in a file's text, comment lines aside. */
function hostsIn(text) {
	const found = new Set();
	for (const line of text.split("\n")) {
		if (/^\s*(?:\/\/|\/?\*)/.test(line)) continue;
		for (const [, host] of line.matchAll(/(?:https?|wss?):\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})/gi)) {
			if (!RESERVED.test(host.toLowerCase())) found.add(host.toLowerCase());
		}
	}
	return found;
}

/** Named in backticks: a link to a page on the host doesn't count as saying the code contacts it. */
const namedInPolicy = (host) => policy.includes(`\`${host}\``);

/** The hosts a policy names in backticks. File names and the token scope look like hosts and aren't. */
const hostsNamed = (text) =>
	[...text.matchAll(/`((?:[a-z0-9-]+\.)+[a-z]{2,})`/g)].map(([, host]) => host).filter((host) => !RESERVED.test(host) && !/\.(json|toml|read)$/.test(host));

const sources = new Map();
for (const path of ["src", "cli/src", "hands", "static"].flatMap((dir) => [...files(join(root, dir))])) {
	for (const host of hostsIn(readFileSync(path, "utf8"))) {
		if (!sources.has(host)) sources.set(host, []);
		sources.get(host).push(relative(root, path).replaceAll("\\", "/"));
	}
}

test("PRIVACY.md names every host the code contacts", () => {
	const missing = [];
	for (const [host, where] of sources) {
		if (namedInPolicy(host)) continue;
		const allowed = NOT_CONTACTED.get(host)?.[1] ?? [];
		for (const file of where) if (!allowed.includes(file)) missing.push(`${host} (${file})`);
	}
	for (const [host, [why]] of OTHER_HOSTS) if (!namedInPolicy(host)) missing.push(`${host} (${why})`);
	assert.deepEqual(missing, [], "name each in PRIVACY.md in backticks, or list it in NOT_CONTACTED with the reason");
});

test("PRIVACY.md names no host that nothing here contacts", () => {
	const contacted = (host) => OTHER_HOSTS.has(host) || (sources.get(host) ?? []).some((file) => !DESCRIBES.has(file));
	const unknown = hostsNamed(policy).filter((host) => !contacted(host));
	assert.deepEqual(unknown, [], "take each out of PRIVACY.md, or list it in OTHER_HOSTS with where it comes from");
	assert.deepEqual(hostsNamed("`gone.vendor.dev`, `settings.json`, `example.com` and `threads.read`"), ["gone.vendor.dev"]);
});

test("every exemption is still needed", () => {
	const stale = [];
	for (const [host, [, allowed]] of NOT_CONTACTED) {
		if (namedInPolicy(host)) stale.push(`${host} is in PRIVACY.md`);
		for (const file of allowed) if (!sources.get(host)?.includes(file)) stale.push(`${host} is not in ${file}`);
	}
	for (const [host, [, file]] of OTHER_HOSTS) {
		if (!existsSync(join(root, file))) stale.push(`${host}: ${file} is gone`);
		if (sources.has(host)) stale.push(`${host} is in the code now`);
	}
	assert.deepEqual(stale, []);
});

test("the scan sees a host in code and skips comments and reserved names", () => {
	const text = ['// see https://in-a-comment.dev', ' * https://in-a-doc.dev', 'fetch("https://telemetry.vendor.dev/v1");', 'new WebSocket("wss://Live.vendor.dev");', '"https://api.example.com"'].join("\n");
	assert.deepEqual([...hostsIn(text)], ["telemetry.vendor.dev", "live.vendor.dev"]);
});
