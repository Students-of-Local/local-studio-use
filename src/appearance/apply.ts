/**
 * Puts the saved theme choice on the side panel: sets mini-lit's tokens as inline custom
 * properties on <html>, which win over the stylesheet's, and follows the Light / Dark / System
 * switch (the `dark` class) and the system setting. Applies at once; nothing reloads.
 */

import { connectStatus } from "../connect/client.js";
import { mirrorMode, setMode } from "./mode.js";
import type { ThemeChoice } from "./palettes.js";
import { APPEARANCE_KEY, appearanceVariables, parseChoice } from "./tokens.js";

let current: ThemeChoice = { preset: "standard" };
let applied: string[] = [];
const listeners = new Set<(choice: ThemeChoice) => void>();

function paint(): void {
	const root = document.documentElement;
	for (const name of applied) root.style.removeProperty(name);
	const vars = appearanceVariables(current, root.classList.contains("dark"));
	for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
	applied = Object.keys(vars);
	// For static/theme-loader.js, which runs before the stored theme can be read.
	try {
		localStorage.setItem(root.classList.contains("dark") ? "tk-paint-dark" : "tk-paint-light", JSON.stringify(vars));
	} catch {
		// Storage is full or blocked: the first frame uses the stylesheet's colors.
	}
}

export function currentAppearance(): ThemeChoice {
	return current;
}

/** Paint this choice now without saving it: the color box fires this while a person drags. */
export function previewAppearance(choice: ThemeChoice): void {
	current = choice;
	paint();
	for (const listener of listeners) listener(choice);
}

/** Use this choice now and keep it in extension storage. */
export async function setAppearance(choice: ThemeChoice): Promise<void> {
	previewAppearance(choice);
	await chrome.storage.local.set({ [APPEARANCE_KEY]: choice });
}

export function onAppearance(listener: (choice: ThemeChoice) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * A panel with no saved choice takes the one `local-studio-browser theme` saved on this computer, so the first
 * click on Light or Dark (or any later change) starts from what the pages already show. Quiet when the helper is absent; it tries again next load.
 */
async function seedFromHelper(): Promise<void> {
	const { theme } = await connectStatus();
	if ((await chrome.storage.local.get(APPEARANCE_KEY))[APPEARANCE_KEY] !== undefined) return;
	await setAppearance(parseChoice(theme));
	if (theme.mode && localStorage.getItem("theme") === null) setMode(theme.mode);
}

/** Read the saved choice, apply it, and keep it applied when the light/dark switch or the system setting changes. */
export async function startAppearance(): Promise<void> {
	let saved = false;
	try {
		const stored = await chrome.storage.local.get(APPEARANCE_KEY);
		saved = stored[APPEARANCE_KEY] !== undefined;
		current = parseChoice(stored[APPEARANCE_KEY]);
	} catch {
		current = { preset: "standard" };
	}
	paint();
	mirrorMode();
	if (!saved) void seedFromHelper().catch(() => {});
	new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}
