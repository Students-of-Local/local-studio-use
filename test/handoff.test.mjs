// "Give this tab to Local Studio" (src/handoff/state.ts): which note a panel takes, and which agents get a menu item.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGE_SITE_ITEM_ID, freshHandoff, HANDOFF_FRESH_MS, itemTarget, MAX_AGENT_ITEMS, menuItems, PANEL_ITEM_ID } from "../src/handoff/state.ts";

test("a panel takes only a fresh, well-formed note for its own window", () => {
	const now = 1_000_000;
	assert.deepEqual(freshHandoff({ windowId: 3, tabId: 9, at: now - 100 }, 3, now), { windowId: 3, tabId: 9, at: now - 100 });
	assert.equal(freshHandoff({ windowId: 4, tabId: 9, at: now }, 3, now), undefined, "another window's note");
	assert.equal(freshHandoff({ windowId: 3, tabId: 9, at: now - HANDOFF_FRESH_MS - 1 }, 3, now), undefined, "a stale note");
	assert.equal(freshHandoff({ windowId: 3, tabId: "9", at: now }, 3, now), undefined);
	assert.equal(freshHandoff(undefined, 3, now), undefined);
	assert.equal(freshHandoff(null, 3, now), undefined);
});

test("the menu lists the panel first, then the agents used most recently, and never a panel chat", () => {
	const now = 10_000_000;
	const agent = (id, used, extra = {}) => ({ id, label: `claude · ${id}`, color: "blue", agent: "claude", lastUsedAt: used, ...extra });
	const items = menuItems(
		[
			agent("bridge-a", now - 5000),
			agent("bridge-b", now - 1000),
			{ id: "tab-12", label: "chat", color: "grey", lastUsedAt: now },
			agent("bridge-old", now - 3 * 60 * 60 * 1000),
		],
		now,
	);
	assert.deepEqual(
		items.map((i) => i.id),
		[PANEL_ITEM_ID, CHANGE_SITE_ITEM_ID, "local-studio-give-agent:bridge-b", "local-studio-give-agent:bridge-a"],
	);
	assert.equal(items[0].title, "Give this tab to Local Studio");
	assert.equal(items[1].title, "Change this site");
	assert.equal(items[2].title, "Give this tab to Claude · bridge-b");
	const many = menuItems(Array.from({ length: 9 }, (_, i) => agent(`bridge-${i}`, now - i)), now);
	assert.equal(many.length, 2 + MAX_AGENT_ITEMS);
	for (const item of [...items, ...many]) assert.doesNotMatch(item.title, /[–—]/);
});

test("a clicked item names the panel or a bridge session, and nothing else", () => {
	assert.deepEqual(itemTarget(PANEL_ITEM_ID), { kind: "panel" });
	assert.deepEqual(itemTarget("local-studio-give-agent:bridge-claude"), { kind: "agent", sessionId: "bridge-claude" });
	assert.equal(itemTarget("local-studio-give-agent:tab-4"), undefined, "a panel chat is not an agent");
	assert.deepEqual(itemTarget(CHANGE_SITE_ITEM_ID), { kind: "site" }, "it gives the tab to no one");
	assert.equal(itemTarget("someone-else"), undefined);
	assert.equal(itemTarget(7), undefined);
});
