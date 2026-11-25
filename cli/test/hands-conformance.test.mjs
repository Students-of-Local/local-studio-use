// The hands protocol (docs/hands-protocol.md): every check in helpers/hands-conformance.mjs against one helper, then the
// same suite against broken copies of the fake helper, each of which it must fail.
//
// CI runs it against the fake. Against a real helper:
//   LOCAL_STUDIO_COMPUTER_CONFORMANCE_BIN=/path/to/local-studio-computer node --test test/hands-conformance.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, HandsSession, runAll } from "./helpers/hands-conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "helpers", "fake-hands.mjs");
const real = process.env.LOCAL_STUDIO_COMPUTER_CONFORMANCE_BIN;

/** Starts the helper under test with `args`; the fake runs under this Node, so it needs no shebang (Windows CI). */
function starter(extraEnv = {}) {
	return (args) => (real ? new HandsSession(real, args, { ...process.env, ...extraEnv }) : new HandsSession(process.execPath, [fake, ...args], { ...process.env, ...extraEnv }));
}

const cache = new Map();
for (const check of CHECKS) {
	test(`${real ? "helper" : "fake helper"}: ${check.name}`, () => check.run(starter(), cache));
}

// On the Mac the mode is a saved value, and Read Only must stop a helper that is already running. Only where the run says
// which mode it set (hands-mac.yml), since it changes that value.
test("mac helper: Read Only set while it runs stops it acting", { skip: !real || process.platform !== "darwin" || process.env.LOCAL_STUDIO_COMPUTER_CONFORMANCE_ACCESS !== "default" }, async () => {
	const s = starter()(["mcp"]);
	try {
		await s.initialize();
		assert.notEqual((await s.call("toggle", { ref: "1" })).envelope.error.retry, "never", "not refused by the mode before");
		execFileSync("defaults", ["write", "local-studio-computer", "agentAccessMode", "read_only"]);
		for (let i = 0; ; i++) {
			const { error } = (await s.call("toggle", { ref: "1" })).envelope;
			if (error.code === "permission_denied" && error.retry === "never") break;
			assert.ok(i < 20, `still acts: ${error.message}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	} finally {
		execFileSync("defaults", ["delete", "local-studio-computer", "agentAccessMode"]);
		await s.close();
	}
});

// The suite is only worth what it catches. Each break below is one way a helper could drift; the suite must fail on it,
// on the check named, and on nothing it shouldn't.
const BREAKS = [
	{ breaks: "drop:toggle", fails: /lists toggle/, why: "a verb missing from tools/list" },
	{ breaks: "drop:run_steps", fails: /lists run_steps|run_steps refuses a step/, why: "run_steps missing from tools/list" },
	{ breaks: "connector-name", fails: /--connector answers initialize with a connector name/, why: "a connector that answers as a local helper" },
	{ breaks: "connector-access", fails: /connector cap/, why: "a connector given Full Access" },
	{ breaks: "connector-manage", fails: /connector cap/, why: "a connector allowed to move windows" },
	{ breaks: "connector-readonly", env: { FAKE_HANDS_ACCESS: "read_only" }, fails: /connector cap|read only/, why: "a Read Only connector raised to Default" },
	{ breaks: "ignore-readonly", env: { FAKE_HANDS_ACCESS: "read_only" }, fails: /read only/, why: "acting verbs that run under Read Only" },
];

for (const { breaks, env = {}, fails, why } of BREAKS) {
	test(`the suite fails on ${why} (${breaks})`, { skip: real ? "runs against the fake only" : false }, async () => {
		const failed = await runAll((args) => new HandsSession(process.execPath, [fake, ...args], { ...process.env, ...env, FAKE_HANDS_BREAK: breaks }));
		assert.ok(failed.length > 0, `the suite passed a helper with ${why}`);
		assert.ok(
			failed.some((f) => fails.test(f.name)),
			`expected a failure named ${fails}; got ${JSON.stringify(failed)}`,
		);
		for (const f of failed) assert.match(f.name, fails, `only the check for ${why} should fail: ${f.name}: ${f.message}`);
	});
}

test("the fake passes with the person's mode at Read Only and at Default too", { skip: real ? "runs against the fake only" : false }, async () => {
	for (const mode of ["read_only", "default"]) {
		const failed = await runAll((args) => new HandsSession(process.execPath, [fake, ...args], { ...process.env, FAKE_HANDS_ACCESS: mode }));
		assert.deepEqual(failed, [], mode);
	}
});
