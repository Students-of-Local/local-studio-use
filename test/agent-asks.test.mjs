// The cards for what agents wait on (src/components/AgentAsks.ts): the side panel shows them above the chat and
// Settings > Agents lists the same ones, one click answers, and no question is lost or left behind.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { addPendingRequest, clearPendingRequests, getPendingRequests, PENDING_KEY, recordDecision, removePendingRequest } from "../src/bridge/permissions.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const ask = (id, more = {}) => ({
	requestId: id,
	clientId: "c1",
	clientName: "claude",
	host: "news.example.com",
	url: "https://news.example.com/today",
	createdAt: 1,
	...more,
});
const upload = { files: [{ name: "cv.pdf", bytes: 2048 }] };
/** The card module fresh, as a newly opened panel loads it. */
const panel = () => import(`../src/components/AgentAsks.ts?ctx=${Math.random()}`);
/** storage.onChanged comes a moment after the write. */
const changed = () => new Promise((r) => setTimeout(r, 20));
/** Waits for `ok`, at most 5 seconds; the assertion after it names what never came. */
const until = async (ok) => {
	const start = Date.now();
	while (!ok() && Date.now() - start < 5000) await changed();
};
/** A panel document to draw in, and the clock the cards read: `later()` is past the moment a moved card ignores clicks. */
const page = new Window({ url: "https://panel.example/" });
globalThis.document = page.document;
const { render } = await import("lit");
let now = 1000;
performance.now = () => now;
const later = () => {
	now += 500;
};
const draw = (what) => {
	if (!page.document.body.firstElementChild) page.document.body.append(page.document.createElement("main"));
	render(what, page.document.body.firstElementChild);
	return [...page.document.querySelectorAll('[data-testid="agent-ask"]')];
};
const buttons = (card) => [...card.querySelectorAll("button")];
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

test("each kind of question offers its own answers: an upload is never allowed for a whole site", async () => {
	installFakeChrome();
	const { askCards } = await panel();
	const cards = draw(
		askCards()([ask("s"), ask("u", { upload }), ask("v", { upload: { files: [...upload.files, ...upload.files] } })], () => undefined),
	);
	const labels = cards.map((c) => buttons(c).map(text));
	assert.deepEqual(labels, [["Allow site", "Allow once", "Deny"], ["Upload this once", "Deny"], ["Upload this once", "Deny"]]);
	const lines = cards.map((c) => text(c.firstElementChild));
	assert.deepEqual(lines, [
		"claude wants to open news.example.com",
		"claude wants to upload a file from this computer to news.example.com",
		"claude wants to upload 2 files from this computer to news.example.com",
	]);
	assert.deepEqual(cards.map((c) => c.dataset.kind), ["site", "upload", "upload"]);
	const answers = [];
	const asked = [ask("s"), ask("u", { upload })];
	const list = askCards();
	const [site, file] = draw(list(asked, (p, d) => answers.push([p.requestId, d])));
	later();
	for (const b of [...buttons(site), ...buttons(file)]) b.click();
	assert.deepEqual(answers, [["s", "allow_host"], ["s", "allow_once"], ["s", "deny"], ["u", "allow_once"], ["u", "deny"]]);
});

test("a card that takes another's place has neither its focus nor the click meant for it", async () => {
	installFakeChrome();
	const { askCards } = await panel();
	const answers = [];
	const list = askCards();
	const show = (...asked) => draw(list(asked, (p, d) => answers.push([p.requestId, d])));
	const one = ask("one");
	const two = ask("two", { upload });
	const [first, second] = show(one, two);
	buttons(first)[0].click();
	assert.deepEqual(answers, [], "a card that just came up takes no click");
	later();
	show(one, two);
	buttons(first)[0].focus();
	assert.ok(page.document.activeElement === buttons(first)[0]);
	// The first question is answered elsewhere, and the second moves up under the pointer.
	const [left] = show(two);
	assert.ok(left === second, "the card is the question's own");
	assert.ok(!left.contains(page.document.activeElement), "focus went with the card that held it");
	buttons(left)[0].click();
	assert.deepEqual(answers, [], "the second half of a double-click");
	later();
	show(two, ask("three"));
	buttons(left)[0].click();
	assert.deepEqual(answers, [["two", "allow_once"]], "a card that stood still answers, whatever comes up below it");
	// The last card goes, and the scrolled list slides the one above it, still first, under the pointer.
	later();
	show(two);
	buttons(left)[0].click();
	assert.equal(answers.length, 1, "any card going starts the wait again for those left");
	later();
	buttons(left)[1].click();
	assert.deepEqual(answers[1], ["two", "deny"]);
});

test("the side panel draws a waiting question; one click answers it and takes the card down", async () => {
	installFakeChrome();
	await addPendingRequest(ask("c1:q1"));
	const { agentAsks, watchAgentAsks } = await panel();
	assert.equal(typeof agentAsks(), "symbol", "nothing before it loads");
	let redraws = 0;
	await watchAgentAsks(() => redraws++);
	const shown = () => buttons(draw(agentAsks())[0]);
	assert.equal(shown().length, 3);
	const before = redraws;
	later();
	shown()[2].click();
	await until(() => typeof agentAsks() === "symbol");
	assert.equal((await chrome.storage.session.get("bridge_decision_c1:q1"))["bridge_decision_c1:q1"], "deny");
	assert.equal(typeof agentAsks(), "symbol", "answered: the card is gone");
	assert.ok(redraws > before);
	// A question asked while the panel is open comes up, and one answered in the agent's own prompt goes.
	await addPendingRequest(ask("c1:q2"));
	await until(() => typeof agentAsks() !== "symbol");
	assert.equal(shown().length, 3);
	await removePendingRequest("c1:q2");
	await until(() => typeof agentAsks() === "symbol");
	assert.equal(typeof agentAsks(), "symbol");
});

test("a question asked while the panel loads still comes up", async () => {
	installFakeChrome();
	const { agentAsks, watchAgentAsks } = await panel();
	const get = chrome.storage.session.get;
	// The panel's read takes a moment, and the question lands after it looked.
	chrome.storage.session.get = async (keys) => {
		const value = await get.call(chrome.storage.session, keys);
		chrome.storage.session.get = get;
		await addPendingRequest(ask("c1:late"));
		await changed();
		return value;
	};
	await watchAgentAsks(() => undefined);
	assert.notEqual(typeof agentAsks(), "symbol", "the late question is drawn");
});

test("two agents asking at once both get a card, an answer takes only its own, and a new worker starts with none", async () => {
	installFakeChrome();
	await Promise.all(["a", "b", "c"].map((id) => addPendingRequest(ask(id))));
	assert.deepEqual((await getPendingRequests()).map((p) => p.requestId).sort(), ["a", "b", "c"]);
	await Promise.all([recordDecision("a", "deny"), addPendingRequest(ask("d")), removePendingRequest("b")]);
	assert.deepEqual((await getPendingRequests()).map((p) => p.requestId).sort(), ["c", "d"]);
	await clearPendingRequests();
	assert.deepEqual(await getPendingRequests(), []);
	assert.equal((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY], undefined);
	assert.match(read("src/bridge/native.ts"), /export function startBridge\(\): void \{\s*clearPendingRequests\(\)/);
});

test("the side panel and Settings > Agents draw the same card", () => {
	const side = read("src/sidepanel.ts");
	assert.match(side, /\$\{agentAsks\(\)\}\s*\$\{updateNotice\(\)\}\s*\$\{modeNotice\(\)\}/, "above the notices, whose going would move the cards");
	// Every way the panel opens watches them: a new chat and a saved one.
	assert.equal(side.match(/watchAgentAsks\(renderApp\)/g).length, side.match(/watchBridgeQuestions\(renderApp\)/g).length);
	assert.match(read("src/dialogs/BridgeTab.ts"), /this\.askCards\(this\.pending, \(p, d\) => this\.decide\(p, d\)\)/);
});
