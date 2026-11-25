/**
 * Light, dark or follow the system: the same setting mini-lit's theme toggle keeps (localStorage "theme", the `dark` class).
 * Dark unless the person chose otherwise: Local Studio's look is the dark one in media/brand/hero.png, so "Match system" is
 * stored by name like the other two.
 */

import { MODE_MIRROR_KEY } from "../browser/veil-shared.js";

export type Mode = "light" | "dark" | "system";

export function currentMode(): Mode {
	const saved = localStorage.getItem("theme");
	return saved === "light" || saved === "system" ? saved : "dark";
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Put the person's setting on screen. */
function showMode(): void {
	const mode = currentMode();
	document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && systemDark()));
}

export function setMode(mode: Mode): void {
	localStorage.setItem("theme", mode);
	showMode();
	mirrorMode();
}

/** Copy the setting where the service worker reads it: the in-use veil on agents' pages follows it (browser/veil.ts). */
export function mirrorMode(): void {
	try {
		void chrome.storage.local.set({ [MODE_MIRROR_KEY]: currentMode() }).catch(() => undefined);
	} catch {
		// Not an extension page (tests): nothing to mirror to.
	}
}

/** Follow the system setting while the mode is "system". */
export function followSystem(): void {
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (currentMode() === "system") showMode();
	});
}
