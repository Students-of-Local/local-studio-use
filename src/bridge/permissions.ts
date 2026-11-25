/**
 * The permission mode and site permissions for bridge sessions (docs/decisions.md, D67). One mode for all of
 * Local Studio, set in Settings > Agents or with `local-studio-browser mode`:
 *
 * - "manual": every new site asks first (the old "ask").
 * - "auto" (the default): an agent on a frontier model opens ordinary sites without asking, and one on a small or
 *   unknown model asks (D60's "Match the model"; the CLI says which in its hello, cli/src/model-tier.ts).
 * - "yolo": nothing asks; agents may open any site (the old "allow_all").
 *
 * Auto asks before a sensitive site (mail, a bank, a password manager: risk-rules.ts) even for a frontier model.
 *
 * Unknown hosts raise a permission request that the harness shows (MCP elicitation) or that the user answers in
 * Settings > Agents. What no mode opens (the extension's own pages, guarded hosts) is checked before the mode.
 */
import type { ModelTier } from "./protocol.js";
import { sensitiveSite } from "./risk-rules.js";

const ENABLED_KEY = "bridge_enabled";
/** The mode, one store for every surface (D67). */
export const MODE_KEY = "permission_mode";
/** The 1.4.0 and earlier site access mode: "by_model", "ask" or "allow_all". Read once, to migrate. */
export const LEGACY_MODE_KEY = "bridge_permission_mode";
/** Set when a migration chose Auto for an install that never chose a mode; the side panel shows it once. */
export const MODE_NOTICE_KEY = "permission_mode_notice";
/** Set once the person has seen the Yolo warning. */
export const YOLO_WARNED_KEY = "permission_yolo_warned";
const HOSTS_KEY = "bridge_allowed_hosts";
export const PENDING_KEY = "bridge_pending_requests";

export type PermissionMode = "manual" | "auto" | "yolo";
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "yolo"];
export type PermissionDecision = "allow_once" | "allow_host" | "deny";

/** What the side panel tells a person whose install moved to Auto without their choosing it. */
export interface ModeNotice {
	/** What was stored before: nothing, or 1.4.0's "Match the model". */
	from: "unset" | "by_model";
	at: number;
}

export interface PendingRequest {
	requestId: string;
	clientId: string;
	clientName: string;
	host: string;
	url: string;
	createdAt: number;
	/**
	 * Set when the question is about putting local files into a page, not opening a site
	 * (docs/decisions.md, D38). The answer covers this one upload and is never remembered.
	 */
	upload?: { files: Array<{ name: string; bytes: number }> };
}

export async function isBridgeEnabled(): Promise<boolean> {
	const data = await chrome.storage.local.get(ENABLED_KEY);
	return data[ENABLED_KEY] !== false;
}

export async function setBridgeEnabled(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

/** A mode by its name, or a legacy name an older CLI or extension sends; anything else is undefined. */
export function asPermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "manual" || value === "auto" || value === "yolo") return value;
	if (value === "ask") return "manual";
	if (value === "allow_all") return "yolo";
	if (value === "by_model") return "auto";
	return undefined;
}

/**
 * The mode a 1.4.0 install's stored site access mode becomes (D67): "ask" is Manual and "allow_all" is Yolo. Nothing
 * stored, or "Match the model", is Auto, and the person is told once, since they never chose what Auto adds.
 */
export function migrateLegacyMode(stored: unknown): { mode: PermissionMode; notice?: ModeNotice["from"] } {
	if (stored === "ask") return { mode: "manual" };
	if (stored === "allow_all") return { mode: "yolo" };
	return { mode: "auto", notice: stored === "by_model" ? "by_model" : "unset" };
}

/** The mode as stored, when it is stored under its own name; a legacy name there is migrated like no mode. */
function storedMode(data: Record<string, unknown>): PermissionMode | undefined {
	const stored = asPermissionMode(data[MODE_KEY]);
	return stored && data[MODE_KEY] === stored ? stored : undefined;
}

/**
 * Every write of the mode runs in here, one at a time across the extension: Web Locks are shared by its worker, side
 * panel and pages, so a migration can't land between another context's read and its choice. A browser without them
 * gets one at a time in this context only.
 */
const oneModeWrite = oneAtATime("local-studio-permission-mode");
/** The same for the questions agents wait on: a worker's write never undoes the one a panel made meanwhile. */
const onePendingWrite = oneAtATime("local-studio-pending-requests");

function oneAtATime(lock: string): <T>(write: () => Promise<T>) => Promise<T> {
	let writes: Promise<unknown> = Promise.resolve();
	return async (write) => {
		const locks = globalThis.navigator?.locks;
		if (locks) return locks.request(lock, { mode: "exclusive" }, write);
		const run = writes.then(write, write);
		writes = run.catch(() => undefined);
		return run;
	};
}

/**
 * The stored mode. An install that has none yet is migrated from its 1.4.0 setting here, on first read (the
 * worker's onInstalled handler, `startFreshInstall`, takes the notice back for a new install). The migration reads
 * again inside the lock and writes only if no mode is stored then, so it never overwrites a person's choice made here
 * or in another page.
 */
export async function getPermissionMode(): Promise<PermissionMode> {
	const first = storedMode(await chrome.storage.local.get([MODE_KEY, LEGACY_MODE_KEY]));
	if (first) return first;
	return oneModeWrite(async () => {
		const data = await chrome.storage.local.get([MODE_KEY, LEGACY_MODE_KEY]);
		const chosen = storedMode(data);
		if (chosen) return chosen;
		const { mode, notice } = migrateLegacyMode(data[LEGACY_MODE_KEY]);
		await chrome.storage.local.set({
			[MODE_KEY]: mode,
			...(notice ? { [MODE_NOTICE_KEY]: { from: notice, at: Date.now() } satisfies ModeNotice } : {}),
		});
		return mode;
	});
}

/** The mode as getPermissionMode would give it, without migrating or writing anything (the runs log reads it). */
export async function peekPermissionMode(): Promise<PermissionMode> {
	const data = await chrome.storage.local.get([MODE_KEY, LEGACY_MODE_KEY]);
	return storedMode(data) ?? migrateLegacyMode(data[LEGACY_MODE_KEY]).mode;
}

/** A new install: Auto, with no notice about a change it never saw. */
export function startFreshInstall(): Promise<void> {
	return oneModeWrite(async () => {
		const data = await chrome.storage.local.get([MODE_KEY, LEGACY_MODE_KEY]);
		if (data[LEGACY_MODE_KEY] !== undefined) return;
		if (data[MODE_KEY] === undefined) await chrome.storage.local.set({ [MODE_KEY]: "auto" });
		await chrome.storage.local.remove(MODE_NOTICE_KEY);
	});
}

/** The notice to show once, if a migration left one. */
export async function getModeNotice(): Promise<ModeNotice | undefined> {
	const data = await chrome.storage.local.get(MODE_NOTICE_KEY);
	return data[MODE_NOTICE_KEY] as ModeNotice | undefined;
}

export async function dismissModeNotice(): Promise<void> {
	await chrome.storage.local.remove(MODE_NOTICE_KEY);
}

/** Setting a mode is a choice, so any notice about the default goes too. */
export function setPermissionMode(mode: PermissionMode): Promise<void> {
	return oneModeWrite(async () => {
		await chrome.storage.local.set({ [MODE_KEY]: mode });
		await chrome.storage.local.remove(MODE_NOTICE_KEY);
	});
}

/** Whether an agent in this mode, on a model of this tier, opens a site no one allowed without asking. */
export function opensAnySite(mode: PermissionMode, tier: ModelTier | undefined): boolean {
	if (mode === "yolo") return true;
	return mode === "auto" && tier === "frontier";
}

/**
 * The mode a client works under: a remote connector session is never in Yolo (D67). Yolo widens what a local agent
 * may do, never what a remote caller may reach, so a remote client in Yolo gets Auto's asks.
 */
export function modeFor(mode: PermissionMode, remote: boolean | undefined): PermissionMode {
	return remote && mode === "yolo" ? "auto" : mode;
}

/**
 * Whether a hello is a remote session's. A CLI from before `remote` says nothing, but `local-studio-browser serve` has named every
 * one of its sessions `remote-<caller>` since it shipped, so an older CLI's are told by that.
 */
export function isRemoteClient(client: { name?: string; remote?: boolean }): boolean {
	return client.remote === true || /^remote-/.test(client.name ?? "");
}

/** A hello's tier as the extension trusts it: anything but a known value, or none (older CLIs), is unknown. */
export function asModelTier(value: unknown): ModelTier {
	return value === "frontier" || value === "small" ? value : "unknown";
}

export async function getAllowedHosts(): Promise<string[]> {
	const data = await chrome.storage.local.get(HOSTS_KEY);
	return (data[HOSTS_KEY] as string[] | undefined) ?? [];
}

export async function allowHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	const normalized = host.toLowerCase();
	if (!hosts.includes(normalized)) await chrome.storage.local.set({ [HOSTS_KEY]: [...hosts, normalized] });
}

export async function revokeHost(host: string): Promise<void> {
	const hosts = await getAllowedHosts();
	await chrome.storage.local.set({ [HOSTS_KEY]: hosts.filter((h) => h !== host.toLowerCase()) });
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * What a person typed for Allowed sites, as the hostname permissions compare (a port or path can't
 * narrow an entry; hostAllowed looks only at the hostname), or the reason it can't be one.
 */
export function normalizeHostInput(input: string): { host: string } | { error: string } {
	const text = input.trim();
	const refused = { error: `"${text}" isn't a site address. Enter one like example.com.` };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return refused;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return refused;
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
	return /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/.test(host) ? { host } : refused;
}

/** "docs.example.com" is covered by an entry for "example.com". */
export function hostAllowed(host: string, allowed: string[]): boolean {
	return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

/**
 * True when the URL is on a host an agent may never open: the public URL of this machine's OAuth
 * approval page and the loopback addresses serve and the hub answer on (issue #94). The native
 * host sends them with each request. An entry is a hostname, which guards every port, or
 * "host:port" ("[::1]:port" for IPv6), which guards that port only: a local dev server on another
 * port stays open. This holds in every permission mode, Yolo included, and covers only
 * agent-driven navigation: a person who opens the page in their own tab is not stopped.
 */
export function isGuardedUrl(url: string, guardedHosts: readonly string[] | undefined): boolean {
	if (!guardedHosts?.length) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "") return false;
	const port = parsed.port || (parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "");
	return guardedHosts.some((entry) => {
		const e = entry.toLowerCase().replace(/\.$/, "");
		const withPort = /^(?:\[([^\]]+)\]|([^:\]]+)):(\d+)$/.exec(e);
		if (withPort) return (withPort[1] ?? withPort[2]) === host && withPort[3] === port;
		return e.replace(/^\[|\]$/g, "") === host;
	});
}

/**
 * Local Studio's own pages (the side panel, Settings, the Connect relay's callers) are never a place a
 * bridge client may take a tab: a page there runs with the extension's rights. Refused in every
 * mode, and never put to the user as a permission prompt.
 */
export function isOwnExtensionUrl(url: string): boolean {
	try {
		let u = new URL(url);
		// blob: and filesystem: URLs carry the origin that made them after the scheme; that document has the extension's rights.
		if (u.protocol === "blob:" || u.protocol === "filesystem:") u = new URL(u.pathname);
		return u.protocol === "chrome-extension:" && u.hostname.toLowerCase() === String(chrome.runtime.id).toLowerCase();
	} catch {
		return false;
	}
}

/**
 * `tier` is the calling client's (its hello); without one the client counts as unknown. `remote` is set for a remote
 * connector session, which is never in Yolo. In Auto a sensitive site (mail, a bank, a password manager, a cloud
 * console, a government or health site, account settings: risk-rules.ts) asks even a frontier model, until the person allows it.
 */
export async function isUrlAllowed(url: string, tier?: ModelTier, remote?: boolean): Promise<boolean> {
	if (isOwnExtensionUrl(url)) return false;
	const mode = modeFor(await getPermissionMode(), remote);
	if (mode === "yolo") return true;
	const host = hostOf(url);
	if (host && hostAllowed(host, await getAllowedHosts())) return true;
	// view-source:, blob: and filesystem: URLs carry the page's own address after the scheme.
	if (opensAnySite(mode, tier)) return !sensitiveSite(url.replace(/^\s*(?:(?:view-source|blob|filesystem):)+/i, ""));
	return !host && url === "about:blank";
}

// ---- pending requests (visible to the sidepanel settings tab) -----------------

export async function getPendingRequests(): Promise<PendingRequest[]> {
	const data = await chrome.storage.session.get(PENDING_KEY);
	return (data[PENDING_KEY] as PendingRequest[] | undefined) ?? [];
}

export function addPendingRequest(request: PendingRequest): Promise<void> {
	return onePendingWrite(async () => {
		const pending = await getPendingRequests();
		await chrome.storage.session.set({ [PENDING_KEY]: [...pending, request] });
	});
}

export function removePendingRequest(requestId: string): Promise<void> {
	return onePendingWrite(async () => {
		const pending = await getPendingRequests();
		await chrome.storage.session.set({ [PENDING_KEY]: pending.filter((p) => p.requestId !== requestId) });
	});
}

/** A new worker waits on no question: one an earlier worker left can't be answered, and its card would stay up. */
export function clearPendingRequests(): Promise<void> {
	return onePendingWrite(() => chrome.storage.session.remove(PENDING_KEY));
}

/**
 * The sidepanel answers a request by writing the decision here; the service
 * worker picks it up through storage.onChanged.
 */
export const DECISION_KEY_PREFIX = "bridge_decision_";

export async function recordDecision(requestId: string, decision: PermissionDecision): Promise<void> {
	await chrome.storage.session.set({ [`${DECISION_KEY_PREFIX}${requestId}`]: decision });
	await removePendingRequest(requestId);
}
