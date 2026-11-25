/**
 * Hand-back with Continue, in the service worker (state.ts has the whole flow). An agent's `handback` call waits here
 * until the user presses Continue in the side panel or on the veil's pill, takes the tab back, closes it, or the wait
 * times out. It runs beside the client's queue (src/bridge/native.ts), like ask_user, so nothing else of the agent's is
 * held up and a reload ends it with an answer.
 *
 * The panel presses Continue by writing `handback_continue_<id>` to chrome.storage.session, which web pages can't
 * reach; the pill's button sends a message the veil checks came from its own script in that tab's top frame.
 */

import { showWaiting } from "../attention/badge.js";
import { BridgeError, withTimeout } from "../bridge/errors.js";
import { isGuardedUrl } from "../bridge/permissions.js";
import { ERR } from "../bridge/protocol.js";
import { releaseAgentViewport } from "../browser/cdp.js";
import { signInSite, writeSignIn } from "../browser/page.js";
import type { BrowserSession } from "../browser/session.js";
import { onVeilContinue, veilWait } from "../browser/veil.js";
import { veilViewFor } from "../browser/veil-state.js";
import { runName } from "../runs/log.js";
import { recordStep, runWaiting } from "../runs/worker.js";
import {
	fromSignInWindow,
	openSignIn,
	SIGN_IN_MESSAGE,
	type SignInMessage,
	signInEnd,
	signInFields,
	signInOrigin,
	signInValues,
} from "./sign-in.js";
import {
	CONTINUE_KEY_PREFIX,
	cleanReason,
	HANDBACK_KEY,
	HANDBACK_TIMEOUT_MS,
	type HandbackEnd,
	type HandbackOutcome,
	handbackOutcome,
	type PendingHandback,
} from "./state.js";

const SESSIONS_KEY = "browser_sessions";
const BRIDGE_ENABLED_KEY = "bridge_enabled";

interface Waiting {
	pending: PendingHandback;
	session: BrowserSession;
	/** The caller's own id, which handback.cancel names. */
	waitId?: string;
	settle: (end: HandbackEnd) => void;
	/** Why a sign-in failed, for the agent. */
	why?: string;
	/** What the user typed is going into the page: the write's own end is the one the agent hears... */
	writing?: boolean;
	/** ...unless the tab went meanwhile. */
	gone?: HandbackEnd;
}

/** How long the page may take over its fields; one whose handler opened an alert holds it until the user answers. */
const CHECK_MS = 10_000;
const WRITE_MS = 20_000;

const waiting = new Map<string, Waiting>();

/** Calls still looking their tab up: one that ends first (a cancel, its client gone) never shows. */
interface Arriving {
	clientId: string;
	waitId?: string;
	end?: HandbackEnd;
}
const arriving = new Set<Arriving>();

/**
 * Cancels that came before their call (`clientId waitId` -> when): handback.cancel skips the checks handback waits on.
 * Entries go after CANCEL_MEMORY_MS. A disconnect keeps them: the call may still be in those checks.
 */
const cancelledEarly = new Map<string, number>();
const CANCEL_MEMORY_MS = 10 * 60 * 1000;

function cancelKey(clientId: string, waitId: string): string {
	return `${clientId} ${waitId}`;
}

/** Tests shorten the wait through the worker's global. */
function timeoutMs(): number {
	const override = (globalThis as { __LOCAL_STUDIO_BROWSER_HANDBACK_MS?: number }).__LOCAL_STUDIO_BROWSER_HANDBACK_MS;
	return typeof override === "number" && override > 0 ? override : HANDBACK_TIMEOUT_MS;
}

let listOps: Promise<unknown> = Promise.resolve();
function editPending(edit: (list: PendingHandback[]) => PendingHandback[]): Promise<void> {
	const run = listOps.then(async () => {
		const data = await chrome.storage.session.get(HANDBACK_KEY);
		const list = (data[HANDBACK_KEY] as PendingHandback[] | undefined) ?? [];
		const next = edit(list);
		await chrome.storage.session.set({ [HANDBACK_KEY]: next });
		await showWaiting("handbacks", next);
	});
	listOps = run.catch(() => undefined);
	return run;
}

/**
 * Wait for the user on one of the session's tabs. `params.tabId` defaults to the current tab; `params.reason` is what
 * the user is asked to do. The tab is not focused: the user goes to it from the panel's card or the tab strip.
 */
export async function handleHandback(
	client: { clientId: string; session: BrowserSession; guardedHosts?: string[] },
	params: Record<string, unknown>,
): Promise<HandbackOutcome> {
	const { session } = client;
	const tabId = typeof params.tabId === "number" ? params.tabId : session.currentTabId;
	if (tabId === undefined || !session.tabIds.includes(tabId))
		throw new BridgeError(
			ERR.NO_TAB,
			tabId === undefined
				? "You have no current tab to hand to the user. navigate first, or pass tabId."
				: `Tab ${tabId} is not one of your tabs (tabs_context lists yours).`,
		);
	const reason = cleanReason(params.reason);
	const limit = timeoutMs();
	const waitId = typeof params.waitId === "string" ? params.waitId.slice(0, 80) : undefined;
	const t0 = Date.now();
	if (waitId && takeEarlyCancel(client.clientId, waitId)) return handbackOutcome("aborted", tabId, reason, limit);
	const call: Arriving = { clientId: client.clientId, waitId };
	arriving.add(call);
	let tab: chrome.tabs.Tab | undefined;
	let signIn: PendingHandback["signIn"];
	let refused: unknown;
	try {
		tab = await chrome.tabs.get(tabId).catch(() => undefined);
		// The page draws at its real size when the user looks at it, not the agent's background viewport.
		if (tab && !call.end) await releaseAgentViewport(tabId).catch(() => undefined);
		if (tab && !call.end && params.signIn !== undefined)
			signIn = await signInRequest(tab, client.guardedHosts, params.signIn);
	} catch (err) {
		refused = err;
	} finally {
		arriving.delete(call);
	}
	if (call.end) return handbackOutcome(call.end, tabId, reason, limit);
	// The page was asked about its fields, so the tab may have gone, or left the session, meanwhile.
	if (tab && params.signIn !== undefined) {
		const here = await chrome.tabs.get(tabId).catch(() => undefined);
		if (!here) return handbackOutcome("closed", tabId, reason, limit);
		if (!session.tabIds.includes(tabId)) return handbackOutcome("taken", tabId, reason, limit);
	}
	if (refused) throw refused;
	if (!tab) throw new BridgeError(ERR.NO_TAB, `Tab ${tabId} is closed.`);
	const view = veilViewFor(session.record);
	const now = Date.now();
	const pending: PendingHandback = {
		id: crypto.randomUUID(),
		clientId: client.clientId,
		sessionId: session.id,
		tabId,
		reason,
		agent: view.agent,
		detail: view.detail,
		color: view.color,
		tabTitle: (tab.title || tab.url || `Tab ${tabId}`).replace(/\s+/g, " ").slice(0, 120),
		...(signIn ? { signIn } : {}),
		createdAt: now,
		expiresAt: now + limit,
	};
	const wait: Waiting = { pending, session, waitId, settle: () => undefined };
	const ended = new Promise<HandbackEnd>((resolve) => {
		const timer = setTimeout(() => wait.settle("timeout"), limit);
		wait.settle = (end) => {
			if (wait.writing) {
				if (end === "closed" || end === "taken") wait.gone = end;
				return;
			}
			clearTimeout(timer);
			resolve(end);
		};
	});
	// One wait per tab: a second call replaces the first, which hears it was stopped.
	for (const w of waiting.values()) if (w.pending.tabId === tabId) w.settle("aborted");
	waiting.set(pending.id, wait);
	await editPending((list) => [...list.filter((p) => p.id !== pending.id), pending]);
	void veilWait(session, tabId, reason);
	// It pops up without the focus: a window that took it would take what the user is typing elsewhere.
	if (signIn) openSignIn(pending.id, false).catch(() => undefined);
	runWaiting(session.id, true, t0);
	let outcome: HandbackOutcome | undefined;
	try {
		outcome = handbackOutcome(await ended, tabId, reason, limit, wait.why);
		return outcome;
	} finally {
		waiting.delete(pending.id);
		void veilWait(session, tabId, undefined);
		runWaiting(session.id, false);
		// The hand-back is a step of the run: its reason, and how it ended.
		recordStep(session.id, {
			who: runName(view),
			tool: "handback",
			params: signIn ? { reason, signIn: signIn.host } : { reason },
			tabId,
			ok: outcome?.status === "continued" || outcome?.status === "signed_in",
			result: { status: outcome?.status ?? "aborted" },
			ms: Date.now() - t0,
		});
		await editPending((list) => list.filter((p) => p.id !== pending.id)).catch(() => undefined);
	}
}

/** What a page function threw, without its stack. */
function pageError(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split("\n")[0].replace(/^(Error: )+/, "");
}

/** The sign-in an agent asked for, checked on the page it names: the site the user is told is the tab's, not the agent's. */
async function signInRequest(
	tab: chrome.tabs.Tab,
	guardedHosts: string[] | undefined,
	value: unknown,
): Promise<PendingHandback["signIn"]> {
	const asked = signInFields(value);
	if ("error" in asked) throw new BridgeError(ERR.BAD_PARAMS, asked.error);
	if (isGuardedUrl(tab.url ?? "", guardedHosts))
		throw new BridgeError(ERR.PERMISSION_DENIED, "Local Studio doesn't act on this page.");
	const site = await withTimeout(signInSite(tab.id as number, asked.fields), CHECK_MS, "The page").catch((err) => {
		throw new BridgeError(ERR.BAD_PARAMS, pageError(err));
	});
	if (!signInOrigin(site.origin))
		throw new BridgeError(
			ERR.BAD_PARAMS,
			"This page is not on https, so a sign-in typed into it can be read on the way. Tell the user.",
		);
	return { ...site, fields: asked.fields };
}

/** The user's answer in the sign-in window. The values go from here into the page and nowhere else. */
async function answerSignIn(message: SignInMessage): Promise<{ error?: string }> {
	const w = waiting.get(message.id);
	const signIn = w?.pending.signIn;
	if (!w || !signIn || w.writing) return { error: "This sign-in is over. Nothing was entered." };
	if (message.action !== "fill") {
		w.settle("declined");
		return {};
	}
	const values = signInValues(message, signIn.fields);
	if (!values) return { error: "A field was empty. Nothing was entered." };
	const { tabId, agent } = w.pending;
	if (!w.session.tabIds.includes(tabId)) {
		w.settle("taken");
		return { error: `The tab isn't ${agent}'s any more. Nothing was entered.` };
	}
	w.writing = true;
	const done = await withTimeout(writeSignIn(tabId, signIn.fields, signIn.origin, values), WRITE_MS, "The page").catch(
		() => undefined,
	);
	w.writing = false;
	if (w.gone) {
		w.settle(w.gone);
		return { error: "The tab went while it was filled in, so it isn't known what went in." };
	}
	const end = signInEnd(done, agent);
	w.why = end.why;
	w.settle(end.why === undefined ? "signed_in" : "failed");
	return end.why === undefined ? {} : { error: end.error };
}

/** End the waits `match` picks with `end`. Returns how many. */
function endWhere(match: (w: Waiting) => boolean, end: HandbackEnd): number {
	let n = 0;
	for (const w of [...waiting.values()])
		if (match(w)) {
			w.settle(end);
			n++;
		}
	return n;
}

/** The same for the calls that show nothing yet. */
function endArriving(match: (c: Arriving) => boolean, end: HandbackEnd): number {
	let n = 0;
	for (const c of arriving)
		if (!c.end && match(c)) {
			c.end = end;
			n++;
		}
	return n;
}

function takeEarlyCancel(clientId: string, waitId: string): boolean {
	const key = cancelKey(clientId, waitId);
	const at = cancelledEarly.get(key);
	return cancelledEarly.delete(key) && at !== undefined && Date.now() - at <= CANCEL_MEMORY_MS;
}

/** The client's own cancel (its call was aborted). */
export function cancelHandback(clientId: string, waitId: unknown): number {
	if (typeof waitId !== "string") return 0;
	const id = waitId.slice(0, 80);
	const ended =
		endWhere((w) => w.pending.clientId === clientId && w.waitId === id, "aborted") +
		endArriving((c) => c.clientId === clientId && c.waitId === id, "aborted");
	if (ended || !id) return ended;
	const now = Date.now();
	for (const [key, at] of cancelledEarly) if (now - at > CANCEL_MEMORY_MS) cancelledEarly.delete(key);
	cancelledEarly.set(cancelKey(clientId, id), now);
	return 0;
}

/** The client left (or every client, `undefined`): nobody hears a Continue any more. */
export function cancelHandbacksFor(clientId: string | undefined): number {
	return (
		endWhere((w) => clientId === undefined || w.pending.clientId === clientId, "disconnected") +
		endArriving((c) => clientId === undefined || c.clientId === clientId, "disconnected")
	);
}

/** Continue on a tab (the veil's pill). */
function continueOnTab(tabId: number): void {
	endWhere((w) => w.pending.tabId === tabId, "continued");
}

/** Wire the panel's Continue, the pill's buttons and the ways a tab leaves the agent. Call once per worker start. */
export function startHandback(): void {
	// Waits a previous worker left have nobody waiting on them.
	editPending(() => []).catch(() => undefined);
	// The pill's Take over moves the tab out of the session, which the session table change below ends as "taken".
	onVeilContinue(continueOnTab);
	chrome.runtime.onMessage.addListener((message, sender, reply) => {
		const m = message as SignInMessage | undefined;
		if (m?.type !== SIGN_IN_MESSAGE || !fromSignInWindow(sender)) return undefined;
		void answerSignIn(m).then(reply);
		return true;
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		endWhere((w) => w.pending.tabId === tabId, "closed");
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local") {
			if (changes[BRIDGE_ENABLED_KEY]?.newValue === false) cancelHandbacksFor(undefined);
			if (SESSIONS_KEY in changes) {
				// The tab left the session (dragged out of the group, released, the session ended): it is the user's.
				const table = (changes[SESSIONS_KEY].newValue ?? {}) as Record<string, { tabIds?: number[] }>;
				endWhere((w) => !table[w.pending.sessionId]?.tabIds?.includes(w.pending.tabId), "taken");
			}
			return;
		}
		if (area !== "session") return;
		for (const key of Object.keys(changes)) {
			if (!key.startsWith(CONTINUE_KEY_PREFIX) || changes[key].newValue === undefined) continue;
			const w = waiting.get(key.slice(CONTINUE_KEY_PREFIX.length));
			w?.settle("continued");
			chrome.storage.session.remove(key).catch(() => undefined);
		}
	});
}
