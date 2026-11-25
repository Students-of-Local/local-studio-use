// The extension adds no CORS headers to any site's responses: its own requests go out under its host permissions, and the
// rules earlier versions saved are taken away (src/utils/provider-cors.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeProviderCorsRules } from "../src/utils/provider-cors.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));

function fakeRules(...ids) {
	const calls = [];
	globalThis.chrome = {
		declarativeNetRequest: {
			getDynamicRules: async () => ids.map((id) => ({ id })),
			updateDynamicRules: async (change) => void calls.push(change),
		},
	};
	return calls;
}

test("no packaged rule or source file changes a response's headers", () => {
	for (const { path } of manifest.declarative_net_request.rule_resources)
		for (const rule of JSON.parse(readFileSync(join(root, "static", path), "utf8"))) assert.notEqual(rule.action.type, "modifyHeaders", path);
	for (const file of readdirSync(join(root, "src"), { recursive: true }))
		if (String(file).endsWith(".ts")) assert.doesNotMatch(readFileSync(join(root, "src", String(file)), "utf8"), /["']modifyHeaders["']/, String(file));
});

test("the extension may reach any provider without a rule", () => {
	for (const origin of ["http://*/*", "https://*/*"]) assert.ok(manifest.host_permissions.includes(origin), origin);
});

test("saved provider rules go, and the site edits' own rules stay", async () => {
	const calls = fakeRules(1, 1999, 2000, 2437, 2999, 3000, 50_000);
	await removeProviderCorsRules();
	assert.deepEqual(calls, [{ removeRuleIds: [2000, 2437, 2999] }]);
});

test("with none saved nothing is written, and a browser without the API is left alone", async () => {
	const calls = fakeRules(50_001);
	await removeProviderCorsRules();
	assert.deepEqual(calls, []);
	globalThis.chrome = {};
	await removeProviderCorsRules();
	assert.match(readFileSync(join(root, "src/background.ts"), "utf8"), /^removeProviderCorsRules\(\)/m);
});
