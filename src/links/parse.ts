/**
 * Links that do something on this computer: `localstudio:` links in an agent's answer, or offered by one over the bridge.
 * Pure: the panel, the worker, the native host and the tests share it, and each parses for itself. A link that isn't
 * exactly one of these forms is not a link. What a button says comes from here, never from the agent's words for it.
 *
 *   localstudio://settings/<section>     Local Studio's own settings
 *   localstudio://browser/<page>         a page of the browser's own
 *   localstudio://system/<pane>          the computer's settings
 *   localstudio://app/<name>             an app
 *   localstudio://reveal?path=<path>     a file or folder, shown in the file manager
 *   localstudio://file?path=<path>       a document or folder, opened
 *   localstudio://shortcut/<name>        a macOS Shortcut
 */

/** Settings sections (src/dialogs/settings-sections.ts), as a link names them. */
export const SECTIONS = {
	providers: "Providers",
	agents: "Agents",
	connections: "Connections",
	skills: "Skills",
	sites: "Sites",
	dictation: "Dictation",
	privacy: "Privacy",
	appearance: "Appearance",
	costs: "Costs",
	about: "About",
} as const;

export const BROWSER_PAGES = {
	extensions: { label: "extensions", url: "chrome://extensions/" },
	shortcuts: { label: "keyboard shortcuts", url: "chrome://extensions/shortcuts" },
	downloads: { label: "downloads", url: "chrome://downloads/" },
	history: { label: "history", url: "chrome://history/" },
	passwords: { label: "passwords", url: "chrome://password-manager/passwords" },
	privacy: { label: "privacy settings", url: "chrome://settings/privacy" },
	appearance: { label: "appearance settings", url: "chrome://settings/appearance" },
	search: { label: "search engine settings", url: "chrome://settings/search" },
	languages: { label: "language settings", url: "chrome://settings/languages" },
	"clear-data": { label: "clear browsing data", url: "chrome://settings/clearBrowserData" },
	"site-settings": { label: "site settings", url: "chrome://settings/content" },
	about: { label: "About page", url: "chrome://settings/help" },
} as const;

/** The computer's settings panes and how a button names each (the commands are in cli/src/open-link.ts). */
export const PANES = {
	general: "General",
	about: "About",
	"software-update": "Software Update",
	storage: "Storage",
	appearance: "Appearance",
	accessibility: "Accessibility",
	displays: "Displays",
	sound: "Sound",
	wifi: "Wi-Fi",
	bluetooth: "Bluetooth",
	network: "Network",
	vpn: "VPN",
	notifications: "Notifications",
	focus: "Focus",
	"screen-time": "Screen Time",
	"lock-screen": "Lock Screen",
	privacy: "Privacy & Security",
	"screen-recording": "Screen Recording",
	"accessibility-access": "Accessibility access",
	microphone: "Microphone",
	camera: "Camera",
	"full-disk-access": "Full Disk Access",
	"login-items": "Login Items",
	users: "Users & Groups",
	passwords: "Passwords",
	keyboard: "Keyboard",
	mouse: "Mouse",
	trackpad: "Trackpad",
	printers: "Printers & Scanners",
	battery: "Battery",
	"desktop-dock": "Desktop & Dock",
	wallpaper: "Wallpaper",
	"date-time": "Date & Time",
	language: "Language & Region",
	sharing: "Sharing",
} as const;

export type Section = keyof typeof SECTIONS;
export type BrowserPage = keyof typeof BROWSER_PAGES;
export type Pane = keyof typeof PANES;

export type Link =
	| { kind: "settings"; section: Section }
	| { kind: "browser"; page: BrowserPage }
	| { kind: "system"; pane: Pane }
	| { kind: "app" | "shortcut"; name: string }
	| { kind: "reveal" | "file"; path: string };

const FORM = /^localstudio:\/\/([a-z]+)(?:\/([^/?#&\\]+)|\?path=([^?#&]+))$/i;
/** Control, formatting (text direction too), private and broken characters, and line separators. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const own = <T extends object>(table: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(table, key);

function decoded(text: string): string | undefined {
	try {
		return decodeURIComponent(text);
	} catch {
		return undefined;
	}
}

function nameIn(text: string): string | undefined {
	const name = decoded(text);
	if (
		!name ||
		name.length > 100 ||
		name !== name.trim() ||
		UNSEEN.test(name) ||
		/[/\\:]/.test(name) ||
		/^[-.]/.test(name)
	)
		return undefined;
	return name;
}

function pathIn(text: string): string | undefined {
	const path = decoded(text);
	if (!path || path.length > 1024 || UNSEEN.test(path)) return undefined;
	if (!/^(\/(?!\/)|~\/|[A-Za-z]:[\\/])/.test(path)) return undefined;
	return path.split(/[\\/]/).includes("..") ? undefined : path;
}

/** The link `text` is, or undefined when it is not one. */
export function parseLink(text: unknown): Link | undefined {
	const form = typeof text === "string" && text.length <= 4096 ? FORM.exec(text) : null;
	if (!form) return undefined;
	const kind = form[1].toLowerCase();
	const [, , rest, query] = form;
	if (query !== undefined) {
		const path = kind === "reveal" || kind === "file" ? pathIn(query) : undefined;
		return path ? { kind: kind as "reveal" | "file", path } : undefined;
	}
	const name = nameIn(rest);
	if (!name) return undefined;
	const key = name.toLowerCase();
	switch (kind) {
		case "settings":
			return own(SECTIONS, key) ? { kind, section: key } : undefined;
		case "browser":
			return own(BROWSER_PAGES, key) ? { kind, page: key } : undefined;
		case "system":
			return own(PANES, key) ? { kind, pane: key } : undefined;
		case "app":
		case "shortcut":
			return { kind, name };
		default:
			return undefined;
	}
}

/** The one way to write a link, for the frame to the host. */
export function linkText(link: Link): string {
	switch (link.kind) {
		case "settings":
			return `localstudio://settings/${link.section}`;
		case "browser":
			return `localstudio://browser/${link.page}`;
		case "system":
			return `localstudio://system/${link.pane}`;
		case "app":
		case "shortcut":
			return `localstudio://${link.kind}/${encodeURIComponent(link.name)}`;
		default:
			return `localstudio://${link.kind}?path=${encodeURIComponent(link.path)}`;
	}
}

/** A settings place an agent may open by itself ("settings/Skills", "system/displays"): opening one changes nothing. */
export function parsePlace(place: unknown): Extract<Link, { kind: "settings" | "browser" | "system" }> | undefined {
	const link = typeof place === "string" ? parseLink(`localstudio://${place}`) : undefined;
	return link && (link.kind === "settings" || link.kind === "browser" || link.kind === "system") ? link : undefined;
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const short = (text: string) => (text.length > 48 ? `${text.slice(0, 47)}…` : text);

/** What the button says. */
export function linkLabel(link: Link, platform: "mac" | "win" | "linux"): string {
	switch (link.kind) {
		case "settings":
			return `Open Local Studio settings: ${SECTIONS[link.section]}`;
		case "browser":
			return `Open the browser's ${BROWSER_PAGES[link.page].label}`;
		case "system":
			return `Open ${PANES[link.pane]} in ${platform === "mac" ? "System Settings" : "system settings"}`;
		case "app":
			return `Open ${short(link.name)}`;
		case "file":
			return `Open ${short(fileName(link.path))}`;
		case "reveal":
			return `Show ${short(fileName(link.path))} in ${{ mac: "Finder", win: "Explorer", linux: "Files" }[platform]}`;
		case "shortcut":
			return `Run the shortcut “${short(link.name)}”`;
	}
}

/** The whole target, for the tooltip. */
export function linkTitle(link: Link): string | undefined {
	if (link.kind === "file" || link.kind === "reveal") return link.path;
	return link.kind === "app" || link.kind === "shortcut" ? link.name : undefined;
}
