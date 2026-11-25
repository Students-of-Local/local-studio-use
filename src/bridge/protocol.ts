/**
 * Wire protocol of the Local Studio bridge. Shared by the extension (src/bridge) and
 * the CLI (cli/src), which imports this file directly.
 *
 *   harness ── stdio MCP ── `local-studio-browser mcp` ── unix socket ── native host ── native messaging ── extension
 *
 * Both socket legs carry `[uint32 LE length][UTF-8 JSON]` frames. The native host
 * copies frames between the two and only adds/strips `clientId`.
 */

import type { SessionMessage } from "../threads/merge.js";
import type { BuildInfo } from "../update/build.js";
import type { ExtensionLocation, Mismatch, UpdateAction, UpdatePolicy } from "../update/logic.js";

/**
 * The native messaging host the extension connects to and the helper registers.
 */
export const NATIVE_HOST_NAME = "com.localstudio.browser";
/** Every host name the helper registers and the extension tries, in order. */
export const NATIVE_HOST_NAMES = [NATIVE_HOST_NAME] as const;
export const PROTOCOL_VERSION = 1;

/** Native messaging caps host->extension frames at 1 MiB; leave headroom. */
export const MAX_FRAME_TO_EXTENSION = 900 * 1024;
/** Extension->host frames may be up to 64 MiB; screenshots live here. */
export const MAX_FRAME_FROM_EXTENSION = 60 * 1024 * 1024;

/**
 * The `files` tool moves file content over the bridge in pieces (docs/decisions.md, D38).
 * To the extension a piece is base64 inside a frame that must stay under MAX_FRAME_TO_EXTENSION:
 * 480 KiB of bytes is 640 KiB of base64, which leaves room for the rest of the frame.
 */
export const FILE_CHUNK_TO_EXTENSION = 480 * 1024;
/** From the extension frames may be large, but a piece stays at 3 MiB of bytes (4 MiB of base64). */
export const FILE_CHUNK_FROM_EXTENSION = 3 * 1024 * 1024;
/** One upload call: at most this many files and this many bytes in all. */
export const FILE_UPLOAD_MAX_FILES = 10;
export const FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** The most one download or page PDF may be. */
export const FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** How long the person has to answer an upload question; no answer is a no. */
export const FILE_ASK_TIMEOUT_MS = 120000;
/** How long the CLI waits for a download or PDF to begin. The bridge's own limit for those is a little less (handlerLimit). */
export const FILE_FETCH_WAIT_MS = 120000;

export interface ClientHello {
	type: "hello";
	client: {
		/** Harness name, shown as the tab group label ("omp", "claude", ...). */
		name: string;
		/** Stable per-conversation id so a reconnect re-adopts its tabs. */
		session?: string;
		/**
		 * True when `session` is the CLI's default (project plus harness), not one the user named:
		 * a second live client with the same default gets its own session ("-2") instead of sharing.
		 */
		auto?: boolean;
		/**
		 * True when the user chose `session` (--session, LOCAL_STUDIO_BROWSER_SESSION, or a rename): only then
		 * does it go in the group title. Ids from older CLIs and remote sessions never do.
		 */
		named?: boolean;
		/** The project the agent works in (its git root or folder name), for the group title. */
		project?: string;
		version?: string;
		/**
		 * How capable the agent's model is (cli/src/model-tier.ts), for the "Match the model" site access mode
		 * (docs/decisions.md, D60). Older CLIs send none; the extension treats a missing or unrecognized tier as unknown.
		 */
		tier?: ModelTier;
		/** The model's name, when the client knows it (LOCAL_STUDIO_BROWSER_MODEL). */
		model?: string;
		/**
		 * A remote session (one through `local-studio-browser serve`: a web connector, a token, a hub's caller) or a scoped one: never
		 * in Yolo, and it may not answer its own asks or change permissions (docs/decisions.md, D67).
		 */
		remote?: boolean;
	};
}

/** "frontier" opens sites like Always allow in the "Match the model" mode; "small" and "unknown" ask first. */
export type ModelTier = "frontier" | "small" | "unknown";

/**
 * One timestamp of a traced call (LOCAL_STUDIO_BROWSER_TRACE, cli/src/hop-trace.ts): a label and the time in ms since the Unix
 * epoch, to a fraction of a ms (`performance.timeOrigin + performance.now()`). Each hop appends its own marks.
 */
export type TraceMark = [label: string, at: number];

/** Now, for a TraceMark: every process on the machine reads the same clock. */
export function traceNow(): number {
	return performance.timeOrigin + performance.now();
}

export interface ClientRequest {
	type: "request";
	id: number;
	method: string;
	params?: Record<string, unknown>;
	/** Present only when the client traces its calls: the marks so far, which each hop extends and the reply returns. */
	trace?: TraceMark[];
}

export type ClientToHost = ClientHello | ClientRequest;

export interface RpcError {
	code: string;
	message: string;
	/**
	 * Set by the extension on an `interrupted` it worded itself (the debugger detached, the page
	 * navigated under the call): the connection is fine, so the client passes it on as it is
	 * instead of treating it as a dropped bridge.
	 */
	source?: "extension";
}

export interface HostWelcome {
	type: "welcome";
	clientId: string;
	hostVersion: string;
	extensionConnected: boolean;
	/** The browser profile behind this host, once its extension has said hello. */
	browserId?: string;
	/** Which browser started this host (a name like Chrome or Brave), when the system said. */
	browserName?: string;
}

export interface HostResponse {
	type: "response";
	id: number;
	result?: unknown;
	error?: RpcError;
	/** The request's trace with every hop's marks added, when it was traced. */
	trace?: TraceMark[];
}

export interface HostEvent {
	type: "event";
	event: string;
	data: Record<string, unknown>;
}

export interface HostExtensionStatus {
	type: "extension_status";
	connected: boolean;
	browserId?: string;
}

export type HostToClient = HostWelcome | HostResponse | HostEvent | HostExtensionStatus;

// ---- host <-> extension ---------------------------------------------------

export interface ExtHello {
	type: "hello";
	version: string;
	protocol: number;
	methods: string[];
	/** The build the extension runs (compiled in). Absent from builds before the update system. */
	build?: BuildInfo;
	/** The extension folder's build-info.json as the browser serves it now (where it loads from). */
	diskBuild?: BuildInfo;
	/**
	 * A random id this browser profile keeps for good (chrome.storage.local), so a client can
	 * tell one browser from another and resend a request only to the browser it started on.
	 */
	browserId?: string;
	/**
	 * What this extension understands beyond `methods`: "chunks" (a host frame over MAX_FRAME_TO_EXTENSION arrives as
	 * HostChunk pieces, src/bridge/chunks.ts) and "eukhe" (the side panel's Local Studio chats, ExtEukhe). A host sends
	 * neither to an extension that did not list it. Absent from builds before batch 3.
	 */
	features?: string[];
}

/**
 * Ask the native host to check, update, roll back, re-run the install step or change the
 * updates setting. Exactly these two fields: the host refuses a frame with anything more
 * (parseUpdateRequest in src/update/logic.ts) and runs only fixed commands.
 */
export interface ExtUpdateAction {
	type: "update_action";
	action: UpdateAction;
}

export interface ExtResponse {
	type: "response";
	clientId: string;
	id: number;
	result?: unknown;
	error?: RpcError;
	/** The request's trace with the extension's marks added, when it was traced. */
	trace?: TraceMark[];
}

export interface ExtEvent {
	type: "event";
	/** Omitted for broadcast events. */
	clientId?: string;
	event: string;
	data: Record<string, unknown>;
}

export interface ExtPong {
	type: "pong";
}

/**
 * A change to the local thread mirror (src/threads/mirror.ts). The host checks every field
 * (cli/src/threads-mirror.ts) and writes only inside its threads folder.
 */
export interface ExtThreadsMirror {
	type: "threads_mirror";
	op: "put" | "delete" | "sync" | "clear";
	id?: string;
	md?: string;
	json?: string;
	meta?: { id: string; title: string; createdAt: string; lastModified: string; messageCount: number; model: string };
	/** op "sync": every thread that should have files; the rest are removed. */
	ids?: string[];
}

/**
 * This browser's site changes, sent whole (src/site-edits/keeper.ts). The host checks every field and keeps them in
 * ~/.local-studio/browser/sites.json (cli/src/sites.ts).
 */
export interface ExtSites {
	type: "sites";
	edits: unknown[];
	adBlock: boolean;
}

/**
 * A subscription sign-in request from the side panel (relayed by the background worker).
 * The host keeps every token; the extension only ever gets status and the loopback proxy's
 * address and secret (cli/src/subscriptions, docs/auth-policy.md).
 */
export interface ExtSubscription {
	type: "subscription";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * A Connect request from the side panel (relayed by the background worker): how this computer is
 * reachable from claude.ai, ChatGPT or grok.com, and the devices behind one connector. The host
 * parses it strictly (cli/src/connect-host.ts) and never returns a secret, a token hash or the passcode.
 */
export interface ExtConnect {
	type: "connect";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

/**
 * One step of a side panel chat that runs on Local Studio's Eukhe daemon (cli/src/eukhe.ts). `conversation` names the
 * panel chat; the host keeps one daemon connection for each. `probe` connects and reads the daemon's hello, `command`
 * sends one daemon command (only the ones in EUKHE_COMMANDS), `close` drops the chat's connection.
 */
export interface ExtEukhe {
	type: "eukhe";
	id: number;
	conversation: string;
	op: "probe" | "command" | "close";
	command?: Record<string, unknown>;
}

/** One operation of the chat sync with the Local Studio app (src/threads/sync.ts, cli/src/chat-sync.ts). */
export type ChatsOp =
	| { op: "index"; chats: { id: string; lastModified: string }[] }
	| {
			op: "put";
			chat: {
				id: string;
				title: string;
				createdAt: string;
				lastModified: string;
				messages: SessionMessage[];
				known: string[];
			};
	  }
	| { op: "forget"; id: string }
	| { op: "threads"; query?: string }
	| { op: "thread"; id: string }
	| { op: "off" };

export interface ExtChats {
	type: "chats";
	id: number;
	op: ChatsOp;
}

/** The host's side of ExtChats: with `id` an answer; without it, what the app added to a chat. */
export interface HostChats {
	type: "chats";
	id?: number;
	result?: Record<string, unknown>;
	error?: RpcError;
	event?: "changed";
	/** With `event`: the chat, the messages the panel has not stored yet, and the app's new name for it. */
	chat?: string;
	messages?: SessionMessage[];
	title?: string;
}

/**
 * Open something on this computer: a link of src/links/parse.ts that the person clicked in the panel, or the computer's
 * own settings for an agent. The host parses it again (cli/src/open-link.ts).
 */
export interface ExtOpen {
	type: "open";
	id: number;
	link: string;
}

export interface HostOpen {
	type: "open";
	id: number;
	result?: { done: string };
	error?: RpcError;
}

export type ExtToHost =
	| ExtOpen
	| ExtChats
	| ExtEukhe
	| ExtHello
	| ExtResponse
	| ExtEvent
	| ExtPong
	| ExtUpdateAction
	| ExtThreadsMirror
	| ExtSites
	| ExtSubscription
	| ExtConnect;

export interface HostClientConnected {
	type: "client_connected";
	clientId: string;
	client: ClientHello["client"];
}

export interface HostClientDisconnected {
	type: "client_disconnected";
	clientId: string;
}

export interface HostForwardedRequest {
	type: "request";
	clientId: string;
	id: number;
	method: string;
	params?: Record<string, unknown>;
	/**
	 * Hostnames an agent may not open: the public URL of this machine's OAuth approval page
	 * (issue #94). Read by the host for each request, so a new `remote setup` takes effect at once.
	 */
	guardedHosts?: string[];
	/** The client's trace with the host's marks added, when the client traces its calls. */
	trace?: TraceMark[];
}

/** Sent as the extension connects: the site changes the host keeps, if any, and the hosts no edit may reach. */
export interface HostSites {
	type: "sites_saved";
	saved?: { localStudioSites: 1; adBlock: boolean; edits: unknown[] };
	guardedHosts: string[];
}

export interface HostPing {
	type: "ping";
}

/** How Local Studio was installed, which decides what "update" does (docs/updates.md). */
export type InstallMode = "release" | "checkout" | "unmanaged";

/** The record of the last update, rollback or reinstall (~/.local-studio/browser/last-update.json). */
export interface LastUpdate {
	/** New for every run; the side panel remembers which one's "What's new" was dismissed. */
	id: string;
	kind: "update" | "rollback" | "reinstall";
	mode: InstallMode;
	at: number;
	from: string;
	to: string;
	/** Release notes (the GitHub release body), release mode. Plain text; never rendered as HTML. */
	notes?: string;
	/** Commits pulled in, newest first, capped; checkout mode. */
	commits?: Array<{ sha: string; subject: string }>;
	totalCommits?: number;
	/** The release page or the compare view. */
	url?: string;
	/** The extension build installed by this run: "What's new" shows once the browser runs it. */
	extensionBuild?: string;
}

/** What the last check found, and everything Settings > Updates shows. */
export interface HostUpdateStatus {
	type: "update_status";
	/** What a person types to run this helper: `local-studio-browser`, or its path where that isn't on PATH. */
	command?: string;
	available: boolean;
	/** Release version, or "<version> (<commit>)" in a checkout. */
	current: string;
	latest?: string;
	channel: string;
	checkedAt: number;
	mode?: InstallMode;
	policy?: UpdatePolicy;
	/** When the host checks next; absent when checks are off. */
	nextCheckAt?: number;
	/** Where updates install: the checkout or ~/.local/share/local-studio-browser/app. */
	root?: string;
	error?: string;
	/** Why "Update now" would refuse right now (local changes, not on main, diverged, elsewhere). */
	blocked?: string;
	/** Commits waiting on origin/main (checkout mode). */
	behind?: number;
	/** The build "Update now" would replace still differs from the checkout's HEAD. */
	needsBuild?: boolean;
	canRollback?: boolean;
	rollbackTo?: string;
	/** A build or release that is built and verified and waits to be activated. */
	staged?: string;
	/** An updater is running in the host right now. */
	updating?: boolean;
	location?: ExtensionLocation;
	mismatch?: Mismatch;
	lastUpdate?: LastUpdate;
	hostBuild?: BuildInfo;
	cliBuild?: BuildInfo;
	extensionBuild?: BuildInfo;
}

export type UpdatePhase =
	| "checking"
	| "downloading"
	| "verifying"
	| "pulling"
	| "installing"
	| "building"
	/** Only helpers from before skills moved to Local Studio send this. */
	| "skills"
	| "waiting"
	| "reloading"
	| "done"
	| "failed";

/** One step of an update the host runs for the extension. */
export interface HostUpdateProgress {
	type: "update_progress";
	action: UpdateAction | "reload" | "install";
	phase: UpdatePhase;
	message: string;
	at: number;
	/** Set on "done" when a build is staged: the extension sends "activate" once no agent runs. */
	staged?: boolean;
	/** Set on "done" when the extension should reload to run the new build. */
	reload?: boolean;
	/** The extension build now on disk, so the reload can tell it worked. */
	extensionBuild?: string;
	/** A result a new host sends again in case the extension missed it; not shown, only matched. */
	replay?: boolean;
}

/** chrome.storage.local key where the extension keeps the last HostUpdateProgress. */
export const UPDATE_PROGRESS_KEY = "local-studio.updateProgress";

/** chrome.storage.local key where the extension keeps the last HostUpdateStatus. */
export const UPDATE_STATUS_KEY = "local-studio.updateStatus";

/** The answer to an ExtSubscription, or a step along the way (`progress`, then `result` or `error`). */
export interface HostSubscription {
	type: "subscription";
	id: number;
	result?: unknown;
	error?: RpcError;
	progress?: Record<string, unknown>;
}

/** The answer to an ExtConnect; `joinHub` sends `progress` first. */
export interface HostConnect {
	type: "connect";
	id: number;
	result?: unknown;
	error?: RpcError;
	progress?: Record<string, unknown>;
}

/**
 * The host's side of ExtEukhe: with `id`, the answer to one probe or command (`result` is the daemon's `data`, or
 * `error`); without it, a frame the daemon pushed for the chat (`event`: a session_event, session_closed or a refused
 * shell step). `closed` says the daemon connection ended.
 */
export interface HostEukhe {
	type: "eukhe";
	conversation: string;
	id?: number;
	result?: unknown;
	error?: RpcError;
	event?: Record<string, unknown>;
	closed?: boolean;
}

/**
 * One piece of a host frame too big for one native message (Chrome caps host to extension at 1 MiB). `data` is base64 of
 * the frame's UTF-8 JSON bytes from `index * piece`; the extension joins the `count` pieces of `id` and handles the
 * frame as if it came whole (src/bridge/chunks.ts).
 */
export interface HostChunk {
	type: "chunk";
	id: number;
	index: number;
	count: number;
	data: string;
}

export type HostToExt =
	| HostOpen
	| HostChats
	| HostEukhe
	| HostChunk
	| HostSubscription
	| HostConnect
	| HostClientConnected
	| HostClientDisconnected
	| HostForwardedRequest
	| HostPing
	| HostSites
	| HostUpdateStatus
	| HostUpdateProgress;

/** Error codes the extension returns. */
export const ERR = {
	BAD_PARAMS: "bad_params",
	NOT_FOUND: "not_found",
	NO_TAB: "no_tab",
	PERMISSION_DENIED: "permission_denied",
	DISABLED: "bridge_disabled",
	INTERNAL: "internal",
	TIMEOUT: "timeout",
	NO_EXTENSION: "no_extension",
	/** An alert, confirm or prompt box is open; answer it with the `dialog` method. */
	DIALOG_OPEN: "dialog_open",
	/**
	 * The bridge dropped while the request was out (extension reload, native host restart), so
	 * it may have run. Clients repeat a read on their own; anything else goes to the agent, which
	 * checks the page before repeating it (never replayed blindly).
	 */
	INTERRUPTED: "interrupted",
	/** The request was refused before it reached the browser (the bridge is restarting); repeating it is safe. */
	NOT_SENT: "not_sent",
	/** A ref names an element that left the page, is hidden now, or shows something else; read_page gives fresh refs. */
	STALE_REF: "stale_ref",
	/** The element exists but a click or fill can't reach it (covered, off screen, not a form control). */
	NOT_ACTIONABLE: "not_actionable",
	/** The page's own script threw (run_js); the message is its error, without a stack. */
	SCRIPT_ERROR: "script_error",
	/** The navigation failed in the network stack (DNS, refused, certificate). */
	NAV_FAILED: "navigation_failed",
	/** The session holds the most tabs it may (MAX_SESSION_TABS); close some first. */
	TAB_LIMIT: "tab_limit",
	/** No Eukhe daemon answers on its socket (Local Studio is not running), or this platform has none yet. */
	EUKHE_UNAVAILABLE: "eukhe_unavailable",
} as const;

/** The features this build's extension lists in its hello (ExtHello.features). */
export const EXTENSION_FEATURES = ["chunks", "eukhe"] as const;

/**
 * Methods with no side effect in the page or the tab strip: repeating one changes nothing, so a
 * client may resend it after the bridge drops. Everything else is sent at most once.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
	"status",
	"tabs.context",
	"session.info",
	"sessions.list",
	"threads.list",
	"threads.read",
	"threads.search",
	"tabs.select",
	"snapshot",
	"text",
	"html",
	"inspect",
	"find",
	"screenshot",
	"wait",
	"console.read",
	"network.read",
	"bridge.debug",
	"bridge.bench",
]);

/** Whether a request may be resent after the bridge dropped with it in flight. */
export function isIdempotent(method: string, params: Record<string, unknown> = {}): boolean {
	if (IDEMPOTENT_METHODS.has(method)) return true;
	// Loading the same URL again is a repeat of a GET; "back" and "forward" twice are not.
	if (method === "navigate")
		return typeof params.url === "string" && params.url !== "back" && params.url !== "forward";
	return false;
}

/** Methods whose result names the tab's page in its own `url`; a script's value (`evaluate`) or a file's `url` is not the tab's. */
export const PAGE_METHODS: ReadonlySet<string> = new Set([
	"tabs.create",
	"tabs.select",
	"tabs.show",
	"navigate",
	"snapshot",
	"text",
	"html",
	"inspect",
	"wait",
]);

/** Methods the extension implements; the CLI maps MCP tools onto these. */
export const BRIDGE_METHODS = [
	"status",
	"tabs.context",
	"tabs.create",
	"tabs.close",
	"tabs.select",
	"tabs.show",
	"tabs.release",
	"session.info",
	"session.end",
	"sessions.list",
	"sessions.rename",
	"sessions.end",
	"sessions.group",
	"navigate",
	"screenshot",
	"screencast.start",
	"screencast.stop",
	"snapshot",
	"actions",
	"text",
	"html",
	"inspect",
	"find",
	"click",
	"hover",
	"drag",
	"type",
	"press",
	"scroll",
	"fill",
	"evaluate",
	"wait",
	"dialog",
	"console.read",
	"network.read",
	"capture",
	// The files tool (src/bridge/files.ts). None is idempotent: a transfer cut off is started again.
	"files.upload.begin",
	"files.upload.chunk",
	"files.upload.commit",
	"files.upload.abort",
	"files.download.begin",
	"files.download.chunk",
	"files.download.end",
	"files.pdf.begin",
	"ask_user",
	"ask_user.cancel",
	"handback",
	"handback.cancel",
	"open_settings",
	"offer_buttons",
	"permission.respond",
	"permission.allow",
	"permission.setMode",
	"threads.list",
	"threads.read",
	"threads.search",
	"bridge.reload",
	"bridge.activate",
	"bridge.debug",
	"bridge.bench",
	"edits.list",
	"edits.add",
	"edits.update",
	"edits.off",
	"edits.remove",
	"edits.adblock",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

// bridge.debug `userScripts`: why in-page scripts can or can't use chrome.userScripts
// (probe and classifier in src/browser/userscripts-status.ts; read by `local-studio-browser doctor`).

/**
 * - ready: the API is present and a call into it succeeded.
 * - not_granted: the optional permission is not granted (the toggle alone is not enough).
 * - toggle_off: the permission is granted but the browser hides or blocks the API.
 * - probe_error: something else failed; `error` has the browser's text.
 */
export type UserScriptsState = "ready" | "not_granted" | "toggle_off" | "probe_error";

export interface UserScriptsStatus {
	state: UserScriptsState;
	/** `chrome.permissions.contains({permissions:["userScripts"]})`; null when that call failed. */
	permissionGranted: boolean | null;
	/** `chrome.userScripts.execute` is a function: the injection path's own check. */
	apiPresent: boolean;
	/** `chrome.userScripts.getScripts()` resolved (execute needs a tab, so this stands in). */
	callWorks: boolean;
	error?: string;
}
