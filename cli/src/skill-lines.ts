/**
 * The line that names the skills for a place: a site, added to the first browser result on its host in a session (spec
 * W5), or an app, added to the first computer_* result that landed on it (W6). Names only: the agent reads a skill with
 * skill_read. The host is the one the extension reports and the app the one the computer-use helper reports, never
 * anything a page or a window wrote.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { COMPUTER_READ_TOOLS } from "./computer.ts";
import type { Skills } from "./skills.ts";

const WAIT_MS = 300;
const TRIES = 3;
const SHOWN = 3;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PLACES = " | for: ";
/** What an app may be called to be asked about: its name goes into the line once a skill lists it. */
const SAFE_APP = /^[\p{L}\p{N}][\p{L}\p{N} ._+&-]{0,63}$/u;
/** An app's id, such as a desktop id; its last part is often the name a skill lists. */
const APP_ID = /^[A-Za-z][\w-]*(?:\.[\w-]+)+\.([\w-]+)$/;
/** Computer tools that land on no app: the ones that only look, and the one that leaves. */
const NO_LANDING = new Set([...COMPUTER_READ_TOOLS, "computer_close"]);

interface Landing {
	host?: string;
}
type Result = { content?: unknown; isError?: unknown } | undefined;

/** The host a page's skills are listed under; undefined for a page that is no public site (about:, chrome:, file:, localhost). */
export function pageHost(url: string): string | undefined {
	if (!/^https?:/i.test(url) || !URL.canParse(url)) return undefined;
	const host = new URL(url).hostname.replace(/\.$/, "").replace(/^www\./, "");
	if (/^127\.|(^|\.)localhost$/.test(host)) return undefined;
	return /^[a-z0-9._-]+$/.test(host) ? host : undefined;
}

/**
 * The app a computer tool's result says it landed on: its bundle id when the helper names one, then its name (on Linux
 * the desktop id or window class), then the last part of either's id. From the result's envelope only; a window's title is the window's own text.
 */
export function landedApp(tool: string, content: unknown[]): string[] {
	const first = content[0] as { text?: unknown } | undefined;
	if (!tool.startsWith("computer_") || NO_LANDING.has(tool) || typeof first?.text !== "string") return [];
	let envelope: { ok?: unknown; data?: { target?: unknown } | null } | null;
	try {
		envelope = JSON.parse(first.text);
	} catch {
		return [];
	}
	if (envelope?.ok !== true || !envelope.data) return [];
	const on = (envelope.data.target ?? envelope.data) as { window?: unknown; bundle?: unknown; app?: unknown };
	if (typeof on !== "object" || on.window === undefined) return [];
	const named = [on.bundle, on.app].filter((name): name is string => typeof name === "string" && SAFE_APP.test(name));
	return [...new Set([...named, ...named.flatMap((name) => APP_ID.exec(name)?.[1] ?? [])])];
}

/** The names in a skill_search answer whose own list of places has `wanted`, or a place `wanted` is part of. */
function namesFor(answer: string, wanted: string): string[] {
	const host = wanted.toLowerCase();
	const names = answer.split("\n").filter((line) => {
		const at = line.lastIndexOf(PLACES);
		const places = at < 0 ? [] : line.slice(at + PLACES.length).split("; ");
		return places.map((place) => place.trim().toLowerCase()).some((place) => place === host || (place.includes(".") && host.endsWith(`.${place}`)));
	});
	return [...new Set(names.map((line) => line.split(" (")[0]).filter((name) => SAFE_NAME.test(name)))].slice(0, SHOWN);
}

export class SkillLines {
	/** Tries made per place; one that is settled (asked, whatever the answer) is at the most. */
	private readonly tries = new Map<string, number>();
	private readonly landing = new AsyncLocalStorage<Landing>();

	constructor(private readonly skills: Pick<Skills, "call">) {}

	/** The page a bridge call reported; `hidden` for one in an incognito window. */
	page(url: string, hidden: boolean): void {
		const landing = this.landing.getStore();
		if (landing) landing.host = hidden ? undefined : pageHost(url);
	}

	/** Wrap a tool handler: its result gets the line when it is the first on its host or app. */
	wrap(tool: string, handler: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown> {
		return async (...args) => {
			const landing: Landing = {};
			const result = (await this.landing.run(landing, () => handler(...args))) as Result;
			if (!result || result.isError || !Array.isArray(result.content)) return result;
			const places = landing.host ? [landing.host] : landedApp(tool, result.content);
			const line = places.length ? await this.line(places) : undefined;
			return line ? { ...result, content: [...result.content, { type: "text", text: line }] } : result;
		};
	}

	/** `places` are one place's names, best first. */
	private async line(places: string[]): Promise<string | undefined> {
		const keys = places.map((place) => place.toLowerCase());
		const tried = Math.max(...keys.map((key) => this.tries.get(key) ?? 0));
		if (tried >= TRIES) return undefined;
		const count = (tries: number) => keys.forEach((key) => void this.tries.set(key, tries));
		// Settled while it is asked, so two results at once get one line.
		count(TRIES);
		let timer: NodeJS.Timeout | undefined;
		const late = new Promise<"failed">((done) => {
			timer = setTimeout(done, WAIT_MS, "failed");
		});
		const line = await Promise.race([this.ask(places), late]);
		clearTimeout(timer);
		if (line !== "failed") return line;
		count(tried + 1);
		return undefined;
	}

	private async ask(places: string[]): Promise<string | undefined | "failed"> {
		for (const place of places) {
			const answer = await this.skills.call("skill_search", { for: place }).catch(() => undefined);
			if (!answer || answer.isError) return "failed";
			const names = namesFor(answer.content.map((part) => part.text).join("\n"), place);
			if (names.length) return `Skills for ${place}: ${names.join(", ")}; skill_read {"name": ...}`;
		}
		return undefined;
	}
}
