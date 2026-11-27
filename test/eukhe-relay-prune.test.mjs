import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { EUKHE_PORT } from "../src/eukhe/types.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "chrome-extension://fake/";

async function loadRelay() {
	const dir = mkdtempSync(join(tmpdir(), "relay-prune-"));
	const stub = join(dir, "native.mjs");
	writeFileSync(
		stub,
		"export const host = { sent: [], handler: undefined };\nexport function onEukheMessage(h) { host.handler = h; }\nexport function sendEukhe(m) { host.sent.push(structuredClone(m)); return true; }\n",
	);
	const out = join(dir, "out.mjs");
	writeFileSync(join(dir, "entry.ts"), `export { startEukheRelay } from ${JSON.stringify(join(repo, "src/eukhe/relay.ts"))};\nexport { host } from ${JSON.stringify(stub)};\n`);
	await build({
		entryPoints: [join(dir, "entry.ts")],
		bundle: true,
		platform: "neutral",
		format: "esm",
		outfile: out,
		logLevel: "silent",
		plugins: [{ name: "native", setup: (b) => b.onResolve({ filter: /bridge\/native\.js$/ }, () => ({ path: stub })) }],
	});
	try {
		return await import(pathToFileURL(out).href);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const event = () => {
	const listeners = [];
	return { listeners, addListener: (fn) => listeners.push(fn) };
};

test("a conversation the panel closes is forgotten: no later event reaches it and the port's end closes it no second time", async () => {
	const connect = event();
	globalThis.chrome = { runtime: { getURL: () => ORIGIN, onConnect: connect } };
	const { startEukheRelay, host } = await loadRelay();
	startEukheRelay();
	const posted = [];
	const port = { name: EUKHE_PORT, sender: { url: `${ORIGIN}sidepanel.html` }, postMessage: (m) => posted.push(m), onMessage: event(), onDisconnect: event(), disconnect() {} };
	for (const fn of connect.listeners) fn(port);
	const ask = (id, conversation, op) => {
		for (const fn of port.onMessage.listeners) fn({ id, conversation, op });
		return host.sent.at(-1);
	};
	const chat = ask(1, "fleet-a", "fleet_chat");
	host.handler({ type: "eukhe", id: chat.id, conversation: chat.conversation, result: { started: true } });
	host.handler({ type: "eukhe", conversation: chat.conversation, event: { type: "fleet_end" } });
	const close = ask(2, "fleet-a", "close");
	assert.equal(close.conversation, chat.conversation);
	host.handler({ type: "eukhe", id: close.id, conversation: close.conversation, result: { closed: true } });
	assert.deepEqual(posted.at(-1), { id: 2, conversation: "fleet-a", result: { closed: true } });
	const before = posted.length;
	host.handler({ type: "eukhe", conversation: chat.conversation, event: { type: "fleet_chunk" } });
	assert.equal(posted.length, before, "a closed conversation gets no more events");
	const kept = ask(3, "fleet-b", "fleet_models");
	const sent = host.sent.length;
	for (const fn of port.onDisconnect.listeners) fn();
	const closes = host.sent.slice(sent).map((m) => [m.op, m.conversation]);
	assert.deepEqual(closes, [["close", kept.conversation]]);
});
