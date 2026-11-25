/**
 * The native host's side of links (src/links/parse.ts): opens the computer's settings, an app, a document or a folder,
 * shows a file in the file manager, runs a Shortcut. The extension sends `{type: "open", id, link}` after the person
 * clicked the button in the side panel, or for a settings pane an agent asked for; the link is parsed again here and
 * anything else is refused. No shell: a program and a list of arguments, never one starting with "-" that a link chose.
 * Nothing here prints to stdout: that stream is the channel to the browser.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { type Link, PANES, type Pane, parseLink } from "../../src/links/parse.ts";
import type { HostOpen } from "../../src/bridge/protocol.ts";

const MAC_PANES: Record<Pane, string> = {
	general: "com.apple.systempreferences.GeneralSettings",
	about: "com.apple.SystemProfiler.AboutExtension",
	"software-update": "com.apple.Software-Update-Settings.extension",
	storage: "com.apple.settings.Storage",
	appearance: "com.apple.Appearance-Settings.extension",
	accessibility: "com.apple.Accessibility-Settings.extension",
	displays: "com.apple.Displays-Settings.extension",
	sound: "com.apple.Sound-Settings.extension",
	wifi: "com.apple.wifi-settings-extension",
	bluetooth: "com.apple.BluetoothSettings",
	network: "com.apple.Network-Settings.extension",
	vpn: "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension",
	notifications: "com.apple.Notifications-Settings.extension",
	focus: "com.apple.Focus-Settings.extension",
	"screen-time": "com.apple.Screen-Time-Settings.extension",
	"lock-screen": "com.apple.Lock-Screen-Settings.extension",
	privacy: "com.apple.settings.PrivacySecurity.extension",
	"screen-recording": "com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
	"accessibility-access": "com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
	microphone: "com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
	camera: "com.apple.settings.PrivacySecurity.extension?Privacy_Camera",
	"full-disk-access": "com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
	"login-items": "com.apple.LoginItems-Settings.extension",
	users: "com.apple.Users-Groups-Settings.extension",
	passwords: "com.apple.Passwords-Settings.extension",
	keyboard: "com.apple.Keyboard-Settings.extension",
	mouse: "com.apple.Mouse-Settings.extension",
	trackpad: "com.apple.Trackpad-Settings.extension",
	printers: "com.apple.Print-Scan-Settings.extension",
	battery: "com.apple.Battery-Settings.extension",
	"desktop-dock": "com.apple.Desktop-Settings.extension",
	wallpaper: "com.apple.Wallpaper-Settings.extension",
	"date-time": "com.apple.Date-Time-Settings.extension",
	language: "com.apple.Localization-Settings.extension",
	sharing: "com.apple.Sharing-Settings.extension",
};

const WIN_PANES: Partial<Record<Pane, string>> = {
	general: "",
	about: "about",
	"software-update": "windowsupdate",
	storage: "storagesense",
	appearance: "personalization",
	accessibility: "easeofaccess",
	displays: "display",
	sound: "sound",
	wifi: "network-wifi",
	bluetooth: "bluetooth",
	network: "network",
	vpn: "network-vpn",
	notifications: "notifications",
	focus: "quiethours",
	"lock-screen": "lockscreen",
	privacy: "privacy",
	microphone: "privacy-microphone",
	camera: "privacy-webcam",
	"full-disk-access": "privacy-broadfilesystemaccess",
	"login-items": "startupapps",
	users: "otherusers",
	passwords: "signinoptions",
	keyboard: "typing",
	mouse: "mousetouchpad",
	trackpad: "devices-touchpad",
	printers: "printers",
	battery: "powersleep",
	"desktop-dock": "taskbar",
	wallpaper: "personalization-background",
	"date-time": "dateandtime",
	language: "regionlanguage",
};

const GNOME_PANES: Partial<Record<Pane, string[]>> = {
	general: [],
	about: ["system", "about"],
	appearance: ["background"],
	accessibility: ["universal-access"],
	displays: ["display"],
	sound: ["sound"],
	wifi: ["wifi"],
	bluetooth: ["bluetooth"],
	network: ["network"],
	vpn: ["network"],
	notifications: ["notifications"],
	"screen-time": ["wellbeing"],
	privacy: ["privacy"],
	microphone: ["privacy", "microphone"],
	camera: ["privacy", "camera"],
	users: ["system", "users"],
	keyboard: ["keyboard"],
	mouse: ["mouse"],
	trackpad: ["mouse"],
	printers: ["printers"],
	battery: ["power"],
	"desktop-dock": ["multitasking"],
	wallpaper: ["background"],
	"date-time": ["system", "datetime"],
	language: ["system", "region"],
	sharing: ["sharing"],
};

const KDE_PANES: Partial<Record<Pane, string[]>> = {
	general: [],
	about: ["kcm_about-distro"],
	appearance: ["kcm_lookandfeel"],
	accessibility: ["kcm_access"],
	displays: ["kcm_kscreen"],
	sound: ["kcm_pulseaudio"],
	wifi: ["kcm_networkmanagement"],
	bluetooth: ["kcm_bluetooth"],
	network: ["kcm_networkmanagement"],
	vpn: ["kcm_networkmanagement"],
	notifications: ["kcm_notifications"],
	"lock-screen": ["kcm_screenlocker"],
	"login-items": ["kcm_autostart"],
	users: ["kcm_users"],
	keyboard: ["kcm_keyboard"],
	mouse: ["kcm_mouse"],
	trackpad: ["kcm_touchpad"],
	battery: ["kcm_powerdevilprofilesconfig"],
	wallpaper: ["kcm_wallpaper"],
	"date-time": ["kcm_clock"],
	language: ["kcm_regionandlang"],
};

/** Documents, pictures, sound and film: what opening shows and never runs. */
const DOCUMENTS = new Set(
	`pdf txt md csv tsv log rtf doc docx xls xlsx ppt pptx odt ods odp pages numbers key epub png jpg jpeg gif webp heic
	mp3 m4a wav flac mp4 mov mkv webm ics vcf json yaml yml toml`.split(/\s+/),
);

export interface Seam {
	platform: NodeJS.Platform;
	home: string;
	env: NodeJS.ProcessEnv;
	/** Start a program; rejects when it can't start or soon exits with an error. */
	start(program: string, args: string[], options?: { verbatim?: boolean }): Promise<void>;
}

/** A refusal in words for the person. */
export class OpenError extends Error {
	constructor(
		readonly code: "bad_params" | "not_found" | "refused" | "failed",
		message: string,
	) {
		super(message);
	}
}

/** How long a program is watched for an early failure; `open` is done by then, a Linux app runs on. */
const WATCH_MS = 3000;

export function start(program: string, args: string[], options: { verbatim?: boolean } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		// Linux launchers hand their stderr to the app they start, which would write to a pipe nobody reads.
		const stdio: ["ignore", "ignore", "pipe" | "ignore"] = ["ignore", "ignore", process.platform === "darwin" ? "pipe" : "ignore"];
		const child = spawn(program, args, { stdio, detached: true, windowsVerbatimArguments: options.verbatim === true });
		let said = "";
		const timer = setTimeout(done, WATCH_MS);
		function done(): void {
			clearTimeout(timer);
			child.stderr?.destroy();
			child.unref();
			resolve();
		}
		child.stderr?.on("data", (d: Buffer) => {
			if (said.length < 2000) said += d.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			// explorer.exe answers 1 when all went well.
			if (code === 0 || program === "explorer.exe") return done();
			clearTimeout(timer);
			reject(new Error(said.trim().split("\n").pop() || `exit ${code}`));
		});
	});
}

const here = (): Seam => ({ platform: process.platform, home: homedir(), env: process.env, start });

function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
	return (env.PATH ?? "").split(delimiter).some((dir) => {
		if (!isAbsolute(dir)) return false;
		try {
			accessSync(join(dir, program), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

async function openPane(pane: Pane, s: Seam): Promise<string> {
	const name = PANES[pane];
	const none = () => new OpenError("not_found", `This computer has no ${name} settings Local Studio can open.`);
	if (s.platform === "darwin") await s.start("/usr/bin/open", [`x-apple.systempreferences:${MAC_PANES[pane]}`]);
	else if (s.platform === "win32") {
		const id = WIN_PANES[pane];
		if (id === undefined) throw none();
		await s.start("explorer.exe", [`ms-settings:${id}`]);
	} else {
		const gnome = onPath("gnome-control-center", s.env);
		if (!gnome && !onPath("systemsettings", s.env))
			throw new OpenError("not_found", "This computer has no settings program Local Studio knows.");
		const args = (gnome ? GNOME_PANES : KDE_PANES)[pane];
		if (!args) throw none();
		await s.start(gnome ? "gnome-control-center" : "systemsettings", args);
	}
	return `Opened ${name} settings.`;
}

/** The `.desktop` file whose Name, or own name, is `name`, whatever the case. */
function desktopEntry(name: string, s: Seam): string | undefined {
	const dirs = [s.env.XDG_DATA_HOME || join(s.home, ".local", "share"), ...(s.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
	const want = name.toLowerCase();
	for (const dir of dirs.filter(isAbsolute)) {
		let files: string[];
		try {
			files = readdirSync(join(dir, "applications")).filter((f) => /^[A-Za-z0-9][\w.+-]*\.desktop$/.test(f));
		} catch {
			continue;
		}
		for (const file of files) {
			const stem = file.slice(0, -".desktop".length);
			try {
				const entry = readFileSync(join(dir, "applications", file), "utf8").slice(0, 64_000);
				const main = entry.slice(entry.indexOf("[Desktop Entry]")).split(/\n\[/)[0];
				if (/^NoDisplay=true$/m.test(main)) continue;
				if (stem.toLowerCase() === want || /^Name=(.*)$/m.exec(main)?.[1].trim().toLowerCase() === want) return stem;
			} catch {}
		}
	}
	return undefined;
}

async function openApp(name: string, s: Seam): Promise<string> {
	if (s.platform === "darwin") {
		await s.start("/usr/bin/open", ["-a", name]).catch(() => {
			throw new OpenError("not_found", `There is no app called ${name} on this Mac.`);
		});
	} else if (s.platform === "win32") {
		throw new OpenError("not_found", "Opening an app from a link isn't on Windows yet.");
	} else {
		const stem = desktopEntry(name, s);
		if (!stem) throw new OpenError("not_found", `There is no app called ${name} on this computer.`);
		await s.start("gtk-launch", [stem]);
	}
	return `Opened ${name}.`;
}

/** The path's real place, every symlink followed. */
function real(path: string, s: Seam): { path: string; folder: boolean; file: boolean } {
	if (/^[A-Za-z]:/.test(path) !== (s.platform === "win32") && !path.startsWith("~/"))
		throw new OpenError("bad_params", "That is not a path on this computer.");
	const full = path.startsWith("~/") ? join(s.home, path.slice(2)) : path;
	try {
		const at = realpathSync(full);
		const stat = statSync(at);
		return { path: at, folder: stat.isDirectory(), file: stat.isFile() };
	} catch {
		throw new OpenError("not_found", `${basename(path)} isn't there any more.`);
	}
}

async function openFile(path: string, s: Seam): Promise<string> {
	const at = real(path, s);
	const name = basename(at.path);
	const kind = extname(name).slice(1).toLowerCase();
	// A folder with an extension is an app or another bundle on a Mac; a name without one could be a program.
	if (at.folder ? kind !== "" : !at.file || !DOCUMENTS.has(kind))
		throw new OpenError("refused", "That kind of file doesn't open from a link. Show it in its folder instead.");
	if (s.platform === "darwin") await s.start("/usr/bin/open", [at.path]);
	else if (s.platform === "win32") await s.start("explorer.exe", [`"${at.path}"`], { verbatim: true });
	else await s.start("xdg-open", [at.path]);
	return `Opened ${name}.`;
}

async function reveal(path: string, s: Seam): Promise<string> {
	const at = real(path, s);
	if (s.platform === "darwin") await s.start("/usr/bin/open", ["-R", at.path]);
	else if (s.platform === "win32") await s.start("explorer.exe", [`/select,"${at.path}"`], { verbatim: true });
	else await s.start("xdg-open", [dirname(at.path)]);
	return `Showing ${basename(at.path)}.`;
}

async function runShortcut(name: string, s: Seam): Promise<string> {
	if (s.platform !== "darwin") throw new OpenError("not_found", "Shortcuts are a Mac feature.");
	await s.start("/usr/bin/shortcuts", ["run", name]);
	return `Started the shortcut “${name}”.`;
}

/** Open a link; the sentence that says what happened. */
export async function openLink(text: unknown, seam: Seam = here()): Promise<string> {
	const link: Link | undefined = parseLink(text);
	if (!link) throw new OpenError("bad_params", "That is not a link.");
	switch (link.kind) {
		case "system":
			return openPane(link.pane, seam);
		case "app":
			return openApp(link.name, seam);
		case "file":
			return openFile(link.path, seam);
		case "reveal":
			return reveal(link.path, seam);
		case "shortcut":
			return runShortcut(link.name, seam);
		default:
			throw new OpenError("bad_params", "That link opens in the browser.");
	}
}

/** Answer one frame: exactly `type`, `id` and `link`. */
export async function answerOpen(message: unknown, seam?: Seam): Promise<HostOpen | undefined> {
	const frame = message as Record<string, unknown>;
	const { id } = frame;
	if (typeof id !== "number" || !Number.isSafeInteger(id)) return undefined;
	if (Object.keys(frame).some((k) => k !== "type" && k !== "id" && k !== "link"))
		return { type: "open", id, error: { code: "bad_params", message: "Unknown field." } };
	try {
		return { type: "open", id, result: { done: await openLink(frame.link, seam) } };
	} catch (err) {
		if (err instanceof OpenError) return { type: "open", id, error: { code: err.code === "bad_params" ? "bad_params" : "not_found", message: err.message } };
		return { type: "open", id, error: { code: "internal", message: `It didn't open: ${err instanceof Error ? err.message : String(err)}` } };
	}
}
