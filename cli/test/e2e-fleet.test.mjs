import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { sleep, startHarness } from "./e2e-harness.mjs";

const PANEL = `chrome-extension://${extensionId.id}/sidepanel.html`;
const SECRET = "The heron flies at dawn over Lake Local Studio";
const PAGE = `<!doctype html><title>Heron notes</title><main><h1>Field notes</h1><p>${SECRET}.</p></main>`;
const KEY = "e2e-fleet-key-7d2b1e";
const MODELS = ["auto", "a-1", "b-2", "c-3"];

async function waitFor(fn, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		let value;
		try {
			value = await fn();
		} catch (err) {
			if (err instanceof assert.AssertionError) throw err;
		}
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

function controller() {
	const chats = [];
	const state = { mode: "ready" };
	const send = (res, chunks) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
		res.end("data: [DONE]\n\n");
	};
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => {
			raw += d;
		});
		req.on("end", () => {
			if (state.mode === "401" || req.headers.authorization !== `Bearer ${KEY}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "fleet key required" } }));
				return;
			}
			if (req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				const ids = state.mode === "empty" ? ["auto"] : MODELS;
				res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }));
				return;
			}
			const body = JSON.parse(raw);
			chats.push(body);
			const result = body.messages.findLast((m) => m.role === "tool");
			if (!result) {
				send(res, [
					{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_page_text", arguments: "" } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]);
				return;
			}
			const said = result.content.match(/The heron[^.]*/)?.[0] ?? "nothing";
			send(res, [
				{ choices: [{ delta: { content: "The page says: " } }] },
				{ choices: [{ delta: { content: said } }] },
				{ choices: [{ delta: { content: "." }, finish_reason: "stop" }] },
				{ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } },
			]);
		});
	});
	return { server, chats, state };
}

test("the panel's local models come from the controller: list, row, picker, a chat with a tool call", { timeout: 180_000 }, async (t) => {
	const stub = controller();
	await new Promise((ok) => stub.server.listen(0, "127.0.0.1", ok));
	t.after(() => {
		stub.server.closeAllConnections();
		stub.server.close();
	});
	const saved = process.env.LOCAL_STUDIO_FLEET_URL;
	process.env.LOCAL_STUDIO_FLEET_URL = `http://127.0.0.1:${stub.server.address().port}/v1`;
	t.after(() => {
		if (saved === undefined) delete process.env.LOCAL_STUDIO_FLEET_URL;
		else process.env.LOCAL_STUDIO_FLEET_URL = saved;
	});

	const h = await startHarness({ name: "fleet-e2e" });
	t.after(() => h.stop());
	mkdirSync(join(h.home, ".local-studio-controller"), { mode: 0o700 });
	writeFileSync(join(h.home, ".local-studio-controller", "config.json"), JSON.stringify({ fleetKey: KEY }), { mode: 0o600 });

	const page = h.mount("heron", PAGE);
	const browserWs = (await (await fetch(`http://${h.devtools}/json/version`)).json()).webSocketDebuggerUrl;
	const { targetId: pageTarget } = await h.cdp(browserWs, "Target.createTarget", { url: page });
	await h.connected();
	const { targetId } = await h.cdp(browserWs, "Target.createTarget", { url: PANEL });
	const panel = async (expression) => {
		const target = (await h.targets()).find((x) => x.id === targetId);
		const r = await h.cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const list = `(document.querySelector("#fleet-list") ?? document.body.appendChild(Object.assign(document.createElement("local-studio-connect-list"), { id: "fleet-list" })))`;
	const row = () => panel(`${list}.querySelector("[data-subscription=studio]")?.innerText ?? ""`);
	const reopen = () => panel(`document.querySelector("#fleet-list")?.remove(), true`);
	const picker = async () => {
		await panel(`[...document.querySelectorAll("button")].find((b) => /a-1|Choose a model|Connect a model/.test(b.innerText) && !b.closest("local-studio-model-page"))?.click(), true`);
		await sleep(1500);
		return panel(`[...document.querySelectorAll('local-studio-model-page section[aria-label="Local Studio"] [data-model-item]')].map((b) => b.title)`);
	};
	const closePicker = () => panel(`document.querySelector("[data-page-back]")?.click(), true`);

	await waitFor(() => panel(`!!document.querySelector("textarea")?.placeholder?.includes("Ask about this page")`), 30_000, "the composer");
	await waitFor(async () => /a-1/.test(await panel(`document.body.innerText`)), 20_000, "a local model on the model button");
	assert.equal(await panel(`!!document.querySelector("[data-welcome-connect]")`), false, "no connect list: a model is ready");

	await waitFor(async () => /3 models ready/.test(await row()), 15_000, "the row's model count");
	assert.match(await row(), /^Local models/);

	assert.deepEqual((await picker()).sort(), ["a-1", "auto", "b-2", "c-3"]);
	await closePicker();

	await h.cdp(browserWs, "Target.activateTarget", { targetId: pageTarget });
	await panel(`(() => {
		const box = document.querySelector("textarea");
		box.focus();
		const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
		set.call(box, "read this page");
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);
	try {
		await waitFor(async () => (await panel(`document.body.innerText`)).includes(`The page says: ${SECRET}.`), 90_000, "the answer from the page");
	} catch (err) {
		throw new Error(`${err.message}\nPanel:\n${await panel(`document.body.innerText`).catch(String)}\nChats: ${JSON.stringify(stub.chats).slice(0, 4000)}`);
	}

	assert.equal(stub.chats.length, 2, "one request for the tool call, one with its result");
	assert.ok(stub.chats[0].tools.some((x) => x.function.name === "get_page_text"), "the panel's tools went with the request");
	assert.equal(stub.chats[0].model, "a-1");
	const second = stub.chats[1].messages;
	const asked = second.find((m) => m.role === "assistant" && m.tool_calls);
	assert.equal(asked.tool_calls[0].function.name, "get_page_text");
	const result = second.find((m) => m.role === "tool");
	assert.equal(result.tool_call_id, "call_1");
	assert.ok(result.content.includes(SECRET), "the tool's result went back in the next request");
	const stored = await panel(`(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null), document.documentElement.outerHTML]))()`);
	assert.ok(!stored.includes(KEY), "the extension never holds the fleet key");

	const session = await panel(`new URL(location.href).searchParams.get("session")`);
	assert.ok(session, "the chat was saved");
	await panel(`new Promise((ok, fail) => {
		const open = indexedDB.open("local-studio-storage");
		open.onerror = () => fail(open.error);
		open.onsuccess = () => {
			const store = open.result.transaction("sessions", "readwrite").objectStore("sessions");
			const get = store.get(${JSON.stringify(session)});
			get.onsuccess = () => {
				const data = get.result;
				data.model = { ...data.model, id: "b-2", api: "eukhe-session", provider: "local-studio" };
				const put = store.put(data);
				put.onsuccess = () => ok(true);
				put.onerror = () => fail(put.error);
			};
		};
	})`);
	await panel(`location.reload(), true`);
	await waitFor(() => panel(`!!document.querySelector("textarea")?.placeholder?.includes("Ask about this page")`), 30_000, "the restored chat's composer");
	const ask = (text) =>
		panel(`(() => {
		const box = document.querySelector("textarea");
		box.focus();
		const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
		set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);
	await ask("read it again");
	try {
		await waitFor(() => stub.chats.length === 3, 30_000, "the restored chat's request");
	} catch (err) {
		throw new Error(`${err.message}\nPanel:\n${await panel(`document.body.innerText`).catch(String)}`);
	}
	assert.equal(stub.chats[2].model, "b-2", "a chat saved on the old provider sends on the same listed model");

	stub.state.mode = "empty";
	await reopen();
	await waitFor(async () => /Running, no model loaded/.test(await row()), 15_000, "running with no model");
	assert.equal(await panel(`!!${list}.querySelector('[aria-label="Check for local models"]')`), true);
	await ask("anything loaded?");
	await waitFor(async () => /Local models are running, but no model is loaded/.test(await panel(`document.body.innerText`)), 15_000, "the no-model toast");
	assert.equal(stub.chats.length, 3, "nothing is sent with no model loaded");

	stub.state.mode = "401";
	await reopen();
	await waitFor(async () => /Fleet key not found/.test(await row()), 15_000, "the key fix");
	if (process.platform === "linux") assert.match(await row(), /systemctl --user restart local-studio-controller/);

	stub.server.closeAllConnections();
	await new Promise((ok) => stub.server.close(ok));
	await panel(`${list}.querySelector('[aria-label="Check for local models"]').click(), true`);
	await waitFor(async () => /Local models aren't running/.test(await row()), 15_000, "the controller down");
	assert.equal(await panel(`!!${list}.querySelector('[aria-label="Check for local models"]')`), true);
	assert.deepEqual(await picker(), []);
});
