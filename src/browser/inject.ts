/**
 * Script injection that works with or without the `userScripts` API.
 *
 * Chromium gates `chrome.userScripts` behind the "Allow User Scripts" toggle even when
 * the optional permission was granted, and Manifest V3 forbids eval in isolated
 * content-script worlds, so arbitrary code strings can only run in two ways:
 *
 * 1. `userScripts.execute` when the toggle is on (isolated world, our own CSP, real
 *    `chrome.runtime.sendMessage` messaging).
 * 2. The debugger's `Runtime.evaluate` otherwise, in an isolated world of the page made for
 *    it: the code carries a chat's attachments and artifacts, so the page's own scripts must
 *    never see its globals. CSP does not apply to it. Messaging is provided by a CDP binding
 *    only that world has: injected code calls a local `chrome.runtime.sendMessage` shim that
 *    posts through the binding, and replies come back through `Runtime.evaluate`.
 *
 * Both paths run the same code; callers do not need to know which one is in use.
 */

import { cdpSend, ensureAttached, PageException } from "./cdp.js";
import { isUserScriptsGated, userScriptsApi } from "./userscripts-status.js";

export function hasUserScripts(): boolean {
	return userScriptsApi() !== undefined;
}

const configuredWorlds = new Set<string>();

export interface InjectOptions {
	/** userScripts world id; ignored on the debugger path. */
	worldId?: string;
	/** userScripts world CSP; ignored on the debugger path. */
	csp?: string;
	/** Enables cancellation (userScripts.terminate or Runtime.terminateExecution). */
	executionId?: string;
}

/** Handles messages the injected code sends through the shim; set once per context. */
export type CdpMessageHandler = (message: Record<string, unknown>, tabId: number) => Promise<unknown>;
let cdpMessageHandler: CdpMessageHandler | undefined;

export function setCdpMessageHandler(handler: CdpMessageHandler): void {
	cdpMessageHandler = handler;
}

/**
 * Runtime providers per sandbox id, mirroring what the sandbox router holds for the
 * userScripts path. The debugger path has no chrome.runtime listener, so messages are
 * routed here: the first provider that responds wins.
 */
interface SandboxProvider {
	handleMessage?(message: unknown, respond: (response: unknown) => void): Promise<void>;
}
const sandboxProviders = new Map<string, SandboxProvider[]>();

export function registerSandboxProviders(sandboxId: string, providers: SandboxProvider[]): void {
	sandboxProviders.set(sandboxId, providers);
}

export function unregisterSandboxProviders(sandboxId: string): void {
	sandboxProviders.delete(sandboxId);
}

export async function dispatchToSandbox(message: Record<string, unknown>): Promise<unknown> {
	const sandboxId = message.sandboxId;
	if (typeof sandboxId !== "string") return undefined;
	const providers = sandboxProviders.get(sandboxId);
	if (!providers) return undefined;
	let response: unknown;
	let responded = false;
	const respond = (r: unknown) => {
		if (responded) return;
		responded = true;
		response = { ...(r as Record<string, unknown>), sandboxId };
	};
	for (const provider of providers) {
		if (provider.handleMessage) await provider.handleMessage(message, respond);
	}
	return response;
}

const BINDING = "__localStudioSend";
/**
 * The isolated world runs on the debugger path use: the page's own scripts see none of its globals, the binding
 * included. One per document, shared by every run of this extension context, whatever its `worldId`. Its name is this
 * context's own, so the worker and a panel never share one and each hears its world being created.
 */
const WORLD = `local-studio-run-${crypto.randomUUID()}`;
/**
 * Each tab's live run worlds, unique id by integer id. The integer ids are per process, so after a navigation another
 * page's context can hold the same one: code and replies are sent by the unique id only.
 */
const worlds = new Map<number, Map<number, string>>();
/** How long runWorld waits for the event that names the world it just made. */
const WORLD_EVENT_MS = 2000;
const words = (err: unknown) => (err instanceof Error ? err.message : String(err));
const notRun = (why: string) =>
	new PageException(
		`Not run: the page changed as the script was about to start (${why}). Call read_page to see the page, then try again.`,
	);
/** Counts each tab's cleared contexts, so a run that began before one never takes a later document's world. */
const clears = new Map<number, number>();
let bindingListenerInstalled = false;
const runningExecutions = new Map<string, number>();

function installBindingListener(): void {
	if (bindingListenerInstalled) return;
	bindingListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		// A frame's own session (frames.ts) numbers its contexts apart from the tab's.
		if (source.tabId === undefined || (source as { sessionId?: string }).sessionId) return;
		const tabId = source.tabId;
		const p = (params ?? {}) as {
			name?: string;
			payload?: string;
			executionContextId?: number;
			context?: { id: number; name: string; uniqueId: string };
		};
		if (method === "Runtime.executionContextCreated" && p.context?.name === WORLD) {
			if (!worlds.has(tabId)) worlds.set(tabId, new Map());
			worlds.get(tabId)?.set(p.context.id, p.context.uniqueId);
		} else if (method === "Runtime.executionContextDestroyed") {
			worlds.get(tabId)?.delete(p.executionContextId ?? -1);
		} else if (method === "Runtime.executionContextsCleared") {
			worlds.delete(tabId);
			clears.set(tabId, (clears.get(tabId) ?? 0) + 1);
		}
		if (method !== "Runtime.bindingCalled" || p.name !== BINDING || !p.payload) return;
		// Read before the handler runs: the document may be gone by its answer. Not one of this context's worlds: no answer.
		const uniqueContextId = worlds.get(tabId)?.get(p.executionContextId ?? -1);
		if (!uniqueContextId) return;
		let parsed: { id: number; message: Record<string, unknown> };
		try {
			parsed = JSON.parse(p.payload);
		} catch {
			return;
		}
		(async () => {
			let response: unknown;
			let error: string | undefined;
			try {
				response = cdpMessageHandler ? await cdpMessageHandler(parsed.message, tabId) : undefined;
			} catch (err) {
				error = words(err);
			}
			const expression = `window.__localStudioReceive && window.__localStudioReceive(${parsed.id}, ${JSON.stringify(
				response ?? null,
			)}, ${JSON.stringify(error ?? null)})`;
			await cdpSend(tabId, "Runtime.evaluate", { expression, uniqueContextId, returnByValue: true }).catch(
				() => undefined,
			);
		})();
	});
	const forget = (tabId: number) => {
		worlds.delete(tabId);
		clears.delete(tabId);
	};
	chrome.tabs.onRemoved.addListener(forget);
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined && !(source as { sessionId?: string }).sessionId) forget(source.tabId);
	});
}

async function ensureBinding(tabId: number): Promise<void> {
	installBindingListener();
	await ensureAttached(tabId);
	// Every time: a detach of the extension's own sends no event, and the console's Runtime.disable drops the binding. Each
	// is a no-op when already in place.
	await cdpSend(tabId, "Runtime.enable");
	// By the world's name, so it is there in each document's world, and never in the page's own.
	await cdpSend(tabId, "Runtime.addBinding", { name: BINDING, executionContextName: WORLD }).catch(() => undefined);
}

/** The run world of the tab's current document, by its unique id, with the binding ready. */
async function runWorld(tabId: number): Promise<string> {
	await ensureBinding(tabId);
	const began = clears.get(tabId);
	let contextId: number;
	try {
		const { frameTree } = await cdpSend<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
		const world = await cdpSend<{ executionContextId: number }>(tabId, "Page.createIsolatedWorld", {
			frameId: frameTree.frame.id,
			worldName: WORLD,
			grantUniveralAccess: false,
		});
		contextId = world.executionContextId;
	} catch (err) {
		// The debugger went (a Cancel on its bar): not the page's doing.
		if (/not attached|detached/i.test(words(err))) throw new PageException(`Not run: ${words(err)}`);
		throw notRun(words(err));
	}
	// The event that names it can land after the answer.
	for (const end = Date.now() + WORLD_EVENT_MS; ; await new Promise((ok) => setTimeout(ok, 20))) {
		const uniqueContextId = worlds.get(tabId)?.get(contextId);
		if (uniqueContextId) return uniqueContextId;
		if (clears.get(tabId) !== began) throw notRun("it went to another document");
		if (Date.now() > end) throw notRun("its script context was not announced");
	}
}

/**
 * Page-side shim, installed once per document: a promise registry plus a
 * `chrome.runtime.sendMessage` lookalike that posts through the CDP binding.
 */
const SHIM = `(() => {
	const w = window;
	if (!Object.hasOwn(w, "__localStudioPending")) {
		w.__localStudioPending = new Map();
		w.__localStudioSeq = 0;
		w.__localStudioReceive = (id, response, error) => {
			const p = w.__localStudioPending.get(id);
			if (!p) return;
			w.__localStudioPending.delete(id);
			if (error) p.reject(new Error(error)); else p.resolve(response);
		};
	}
	if (!Object.hasOwn(w, "__localStudioChrome")) {
		w.__localStudioChrome = {
			runtime: {
				id: "local-studio-browser",
				sendMessage: (message) => new Promise((resolve, reject) => {
					const id = ++w.__localStudioSeq;
					w.__localStudioPending.set(id, { resolve, reject });
					w.${BINDING}(JSON.stringify({ id, message }));
				}),
			},
		};
	}
})();`;

async function cdpInject<T>(
	tabId: number,
	code: string,
	options: InjectOptions,
	/** The world to run in (runWorld). Never the page's main world: without one, nothing runs. */
	uniqueContextId: string,
): Promise<T> {
	// `chrome` inside the injected code resolves to the shim; the page's own window.chrome is untouched.
	const expression = `${SHIM}\n(async () => { const chrome = window.__localStudioChrome; return await (${code}); })()`;
	if (options.executionId) runningExecutions.set(options.executionId, tabId);
	try {
		// A Stop that came while it attached: nothing is sent (first-F3 of the review of PR 265).
		if (options.executionId && terminated.has(options.executionId))
			throw new PageException("The script was stopped before it ran. Nothing was done on the page.");
		const result = await cdpSend<{
			result: { value?: T; description?: string };
			exceptionDetails?: { exception?: { description?: string }; text?: string };
		}>(tabId, "Runtime.evaluate", { expression, uniqueContextId, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new PageException(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
			);
		}
		return result.result.value as T;
	} catch (err) {
		if (err instanceof PageException) throw err;
		// The document went before the code reached its world: it ran nowhere.
		if (/uniqueContextId not found/i.test(words(err))) throw notRun(words(err));
		// It ran to its end, or was stopped: nothing was cut off.
		if (/Execution was terminated/i.test(words(err))) throw err;
		if (/Object reference chain is too long|returned by value/i.test(words(err)))
			throw new PageException(`The script ran, but its value can't be returned as JSON (${words(err)}).`);
		// Sent to the page, then cut off (a detach, a navigation): it may have run (first-F2 of the review of PR 265).
		throw new PageException(
			`The script was sent to the page, then cut off (${words(err)}), so it was not run again: it may have acted on the page. Call read_page to see the page before you act again.`,
		);
	} finally {
		if (options.executionId) {
			runningExecutions.delete(options.executionId);
			terminated.delete(options.executionId);
		}
	}
}

/** A result whose JSON runs past this many characters is not kept for a lost run: the call then fails instead. */
const KEPT_RESULT_CHARS = 256_000;
/** The message a run sends the extension, in the userScripts world's own messaging: nothing is left in the page. */
const RUN_MESSAGE = "local-studio-run";

/** Each userScripts run of this context, by its mark: whether the extension heard it start, and its kept result. */
const runs = new Map<string, { started: boolean; kept?: string }>();
/** Runs a person stopped: a stopped run that gave no result never goes to the debugger path (second-F4). */
const terminated = new Set<string>();
let listening = false;

/** Answer only this context's own runs: the worker and each panel all hear every user-script message. False when this
 * context can't hear a run start (second-F6 of the review of PR 265). */
function listenForRuns(): boolean {
	if (!chrome.runtime.onUserScriptMessage) return false;
	if (listening) return true;
	listening = true;
	chrome.runtime.onUserScriptMessage.addListener((message, _sender, sendResponse) => {
		const m = message as { type?: string; mark?: string; step?: string; kept?: string };
		const run = m?.type === RUN_MESSAGE && m.mark ? runs.get(m.mark) : undefined;
		if (!run) return;
		if (m.step === "start") run.started = true;
		else if (typeof m.kept === "string") run.kept = m.kept;
		sendResponse(true);
	});
	return true;
}

/**
 * Run `code` (an expression or IIFE, may return a promise) in the page and return
 * its value, matching userScripts.execute's `results[0].result`.
 *
 * userScripts.execute can come back with no result for a run (a browserjs() that read `undefined` a dozen times in a
 * row, 2026-11-07). The code is then run on the debugger path only when it never started: a run tells the extension
 * it is starting, and waits for the answer, before its code runs, and sends a small result back after. A run the
 * extension heard start is never run again: its kept result is returned, or the call fails. Nothing is written to the
 * page (first-F1, first-F2 of the review of PR 260).
 */
export async function injectScript<T = unknown>(tabId: number, code: string, options: InjectOptions = {}): Promise<T> {
	const api = userScriptsApi();
	// Nothing has run yet, so the debugger path is safe when a start could not be heard.
	if (!api || !listenForRuns()) return cdpInject<T>(tabId, code, options, await runWorld(tabId));
	const worldId = options.worldId ?? "local-studio-browser";
	const mark = crypto.randomUUID();
	const send = (fields: string) =>
		`chrome.runtime.sendMessage({ type: ${JSON.stringify(RUN_MESSAGE)}, mark: ${JSON.stringify(mark)}, ${fields} })`;
	const marked = `(async () => {
	if ((await ${send('step: "start"')}.catch(() => false)) !== true)
		throw new Error("Not run: Local Studio could not record that this script started. Try again.");
	const v = await (${code});
	let size = 0;
	let kept;
	try {
		kept = JSON.stringify([v], (_k, x) => {
			size += _k.length + (typeof x === "string" ? x.length : 16);
			if (size > ${KEPT_RESULT_CHARS}) throw 0;
			return x;
		});
	} catch {}
	if (kept !== undefined && kept.length <= ${KEPT_RESULT_CHARS}) await ${send('step: "done", kept')}.catch(() => undefined);
	return { v };
})()`;
	runs.set(mark, { started: false });
	try {
		let results: Awaited<ReturnType<typeof api.execute>>;
		try {
			if (!configuredWorlds.has(worldId)) {
				try {
					await api.configureWorld({ worldId, messaging: true, csp: options.csp });
				} catch (err) {
					if (isUserScriptsGated(err)) throw err;
					/* already configured */
				}
				configuredWorlds.add(worldId);
			}
			results = await api.execute({
				js: [{ code: marked }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId,
				injectImmediately: true,
				...(options.executionId && api.terminate ? { executionId: options.executionId } : {}),
			});
		} catch (err) {
			// Present but refused (permission or toggle): the code never ran, so the debugger path runs it.
			if (isUserScriptsGated(err)) return cdpInject<T>(tabId, code, options, await runWorld(tabId));
			throw err;
		}
		const first = results[0];
		if (first?.error) throw new PageException(String((first.error as { message?: string }).message ?? first.error));
		const envelope = first?.result as { v: T } | undefined;
		// Any result object is the run's own envelope (a `v` of undefined may arrive with the key gone).
		if (envelope && typeof envelope === "object") return envelope.v;
		// Closed before any fallback: a start that arrives from now on gets no answer, so its code never runs
		// (first-F1 of the review of PR 265). Only then can the debugger path run it.
		const run = runs.get(mark);
		runs.delete(mark);
		return await lostResult<T>(tabId, code, options, run);
	} finally {
		runs.delete(mark);
		if (options.executionId) terminated.delete(options.executionId);
	}
}

/** userScripts gave no result: run the code on the debugger path only if it never started and was not stopped. */
async function lostResult<T>(
	tabId: number,
	code: string,
	options: InjectOptions,
	run: { started: boolean; kept?: string } | undefined,
): Promise<T> {
	if (run?.started) {
		if (run.kept !== undefined) return (JSON.parse(run.kept) as [T])[0];
		throw new PageException(
			"The script ran, but its result was lost, so it was not run again: it may have acted on the page. Call read_page to see the page before you act again.",
		);
	}
	if (options.executionId && terminated.has(options.executionId))
		throw new PageException("The script was stopped before it ran. Nothing was done on the page.");
	let world: string;
	try {
		world = await runWorld(tabId);
	} catch (err) {
		if (err instanceof PageException) throw err;
		// It never ran on either path (second-F5): say so, with the debugger's own words.
		throw new PageException(
			`Not run: the page did not answer, and the debugger could not attach (${words(err)}). Try again.`,
		);
	}
	return await cdpInject<T>(tabId, code, options, world);
}

/** Cancel a running injection on either path. */
export async function terminateInjection(tabId: number, executionId: string): Promise<boolean> {
	const api = userScriptsApi();
	terminated.add(executionId);
	let stopped = false;
	if (api?.terminate) {
		await api.terminate(tabId, executionId);
		stopped = true;
	}
	// A run on the debugger path, a userScripts run's fallback included (first-F3 of the review of PR 265).
	if (runningExecutions.has(executionId)) {
		await cdpSend(tabId, "Runtime.terminateExecution").catch(() => undefined);
		stopped = true;
	}
	return stopped;
}

export function supportsTermination(): boolean {
	return true;
}
