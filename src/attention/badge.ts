/**
 * The toolbar icon's badge: how many things wait on the user, across agents' questions (src/ask/bridge-worker.ts) and
 * hand-backs (src/handback/worker.ts). Both run in the service worker and pass their whole list here after each change,
 * so the badge never reads storage and never lags the list it counts.
 */

interface Lists {
	questions: ReadonlyArray<{ agentName?: string }>;
	handbacks: ReadonlyArray<{ agent?: string; reason?: string }>;
}

const lists: Lists = { questions: [], handbacks: [] };

export async function showWaiting<K extends keyof Lists>(kind: K, list: Lists[K]): Promise<void> {
	lists[kind] = list;
	const { questions, handbacks } = lists;
	const count = questions.length + handbacks.length;
	const title = handbacks.length
		? `Local Studio: ${handbacks[0].agent ?? "An agent"} needs you (${handbacks[0].reason ?? "your turn"})`
		: questions.length
			? `Local Studio: ${questions[0].agentName ?? "An agent"} is asking you a question`
			: "Open Local Studio";
	const action = chrome.action;
	try {
		await action.setBadgeBackgroundColor?.({ color: "#b8512a" });
		await action.setBadgeText?.({ text: count ? String(count) : "" });
		await action.setTitle?.({ title });
	} catch {
		// A badge is a hint; the panel shows the cards either way.
	}
}
