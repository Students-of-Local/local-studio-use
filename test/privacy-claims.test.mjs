import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const flat = (path) => read(path).replace(/\s+/g, " ");

test("every page that says what Manual asks also says links and redirects aren't checked", () => {
	for (const path of ["PRIVACY.md", "GUIDE.md", "store/permissions.md", "store/listing.md", "docs/remote.md"]) {
		const text = flat(path);
		assert.doesNotMatch(text, /Manual asks before every new site|Sites you haven't allowed still ask first/, path);
		assert.match(text, /[Ww]here a clicked link or a redirect leads isn't checked/, path);
	}
});

test("PRIVACY.md names an off command for each thing that lets another machine in, and each exists", () => {
	const cli = read("cli/src/index.ts");
	for (const name of ["remote", "link", "hub"]) {
		assert.match(flat("PRIVACY.md"), new RegExp(`\`tychicus ${name} off\``), name);
		const command = cli.slice(cli.indexOf(`case "${name}": {`));
		assert.match(command.slice(0, command.indexOf("\n\t\t}")), /"off"/, name);
	}
});

test("the pages say which tools change a site in the user's own tabs", () => {
	for (const part of ["Site edits, feed filters and site scripts", "also applies in the user's tabs", "ad blocking on"]) {
		assert.ok(flat("PRIVACY.md").includes(part), part);
	}
	assert.doesNotMatch(flat("GUIDE.md"), /the only tool that changes what you see/);
	assert.match(read("store/permissions.md"), /^\| `scripting` \|.*feed filter/m);
	assert.match(read("store/permissions.md"), /^\| `declarativeNetRequest` \|.*asks an agent to/m);
});

test("the guide's connector steps are the relay's", () => {
	const part = flat("GUIDE.md").split("### claude.ai, ChatGPT and grok.com")[1].split("### Other agents")[0];
	assert.doesNotMatch(part, /no relay|enter your passcode/);
	for (const said of ["a relay on your own free Cloudflare account", "connect code", "--tailscale", "--cloudflare"]) {
		assert.ok(part.includes(said), said);
	}
});
