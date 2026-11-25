/**
 * The cards in every open side panel after an agent saved a site change (changes.ts): who changed which site, in words,
 * with Undo and Keep. A script is shown closed, off, with the one button besides Settings > Sites that turns it on.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { Paintbrush } from "lucide";
import { allowPageScripts, pageScriptsWait } from "../browser/userscripts-status.js";
import { Toast } from "../components/Toast.js";
import { CARD_MS, CHANGES_KEY, clearChanges, openChanges, type SiteChange } from "./changes.js";
import { type SiteEdit, STORAGE_KEY } from "./common.js";
import { load, type SiteEditsState } from "./state.js";
import { changeTitle } from "./words.js";

const SHOWN = 4;

/** What changes an edit, on first use: it carries the Public Suffix List, which would load with every panel. */
const edits = () => import("./store.js");

let changes: SiteChange[] = [];
let state: SiteEditsState = { edits: [], adBlock: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;

function draw(): void {
	for (const l of listeners) l();
	// The next card to close by itself.
	clearTimeout(expiry);
	const next = Math.min(...openChanges(changes, Date.now()).flatMap((c) => (c.kind === "script" ? [] : [c.at])));
	if (Number.isFinite(next)) expiry = setTimeout(draw, Math.max(0, next + CARD_MS - Date.now()) + 50);
}

async function read(): Promise<void> {
	const [data, edits] = await Promise.all([chrome.storage.session.get(CHANGES_KEY), load()]);
	changes = openChanges(data[CHANGES_KEY], Date.now());
	state = edits;
}

/** Load what agents changed and call `onChange` whenever it changes. */
export async function watchSiteChanges(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= read().then(() => {
		chrome.storage.onChanged.addListener((changed, area) => {
			if ((area === "session" && CHANGES_KEY in changed) || (area === "local" && STORAGE_KEY in changed))
				void read().then(draw);
		});
	});
	await loading;
	draw();
	return () => listeners.delete(onChange);
}

interface Card {
	host: string;
	who: string;
	items: Array<{ change: SiteChange; edit: SiteEdit }>;
}

/** One card a site and agent, oldest first. A change whose edit is gone, or a script already on, has nothing to ask. */
function cards(): Card[] {
	const out: Card[] = [];
	for (const c of openChanges(changes, Date.now())) {
		const edit = state.edits.find((e) => e.id === c.id);
		if (!edit || (edit.kind === "script" && edit.on)) continue;
		const card = out.find((x) => x.host === c.host && x.who === c.who);
		if (card) card.items.push({ change: c, edit });
		else out.push({ host: c.host, who: c.who, items: [{ change: c, edit }] });
	}
	return out;
}

/** Takes back what the card lists: a new edit goes, a changed one gets its old value. */
async function undo(card: Card): Promise<void> {
	const { change, removed, updated } = await edits();
	await change((s) => {
		let next = s;
		for (const { change: c } of card.items) {
			if (!next.edits.some((e) => e.id === c.id)) continue;
			next = c.before ? updated(next, c.id, c.before.value, c.before.note) : removed(next, c.id);
		}
		return { state: next, result: undefined };
	});
	await keep(card);
}

async function keep(card: Card): Promise<void> {
	await clearChanges(card.items.map((i) => i.change.id));
}

/** The person's click: with Settings > Sites, the only way a script turns on. */
async function turnOn(edit: SiteEdit): Promise<void> {
	const asked = allowPageScripts();
	const { change, switched } = await edits();
	await change((s) => ({ state: switched(s, edit.id, true, "person"), result: undefined }));
	await clearChanges([edit.id]);
	const wait = pageScriptsWait(await asked);
	if (wait) Toast.info(wait);
}

const failed = (err: unknown) => Toast.error(err instanceof Error ? err.message : String(err));

function line({ edit, change: c }: Card["items"][number]): TemplateResult {
	if (edit.kind !== "script")
		return html`<li class="break-words">${c.before ? "Changed: " : nothing}${changeTitle(edit)}</li>`;
	return html`<li class="break-words">
		Script, off: ${changeTitle(edit)}
		<details class="tk-more mt-1">
			<summary>Read the code</summary>
			<pre class="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">${edit.value}</pre>
		</details>
		<div class="mt-1.5 flex items-center justify-between gap-2">
			<span class="text-xs text-muted-foreground">It would run on ${edit.host} signed in as you.</span>
			<button
				type="button"
				class="tk-ask-btn tk-ask-btn-ghost shrink-0"
				data-action="turn-on"
				@click=${() => void turnOn(edit).catch(failed)}
			>
				Turn on
			</button>
		</div>
	</li>`;
}

/** The cards; nothing when no agent changed a site lately. */
export function siteChangeCards(): TemplateResult | typeof nothing {
	const open = cards();
	if (open.length === 0) return nothing;
	return html`<div class="shrink-0 px-3 py-2 space-y-2 border-b border-border" data-testid="site-changes">
		${repeat(
			open,
			(card) => `${card.host} ${card.who}`,
			(card) => {
				const scripts = card.items.filter((i) => i.edit.kind === "script");
				const rest = card.items.filter((i) => i.edit.kind !== "script");
				return html`<section
					class="tk-ask-card"
					role="group"
					aria-label=${`${card.who} changed ${card.host}`}
					data-testid="site-change-card"
					data-host=${card.host}
				>
					<div class="flex items-center gap-2 text-sm">
						<span class="tk-ask-icon" aria-hidden="true">${icon(Paintbrush, "sm")}</span>
						<span class="font-semibold text-foreground min-w-0 break-words">${card.who} changed ${card.host}</span>
					</div>
					<ul class="mt-1.5 space-y-1 text-sm text-foreground">
						${rest.slice(0, SHOWN).map(line)}
						${rest.length > SHOWN ? html`<li class="text-muted-foreground">and ${rest.length - SHOWN} more</li>` : nothing}
						${scripts.map(line)}
					</ul>
					<div class="mt-3 flex items-center justify-end gap-2">
						<button type="button" class="tk-ask-btn tk-ask-btn-ghost" data-action="undo" @click=${() => void undo(card).catch(failed)}>
							${rest.length ? "Undo" : "Remove"}
						</button>
						<button type="button" class="tk-ask-btn tk-ask-btn-primary" data-action="keep" @click=${() => void keep(card).catch(failed)}>
							${rest.length ? "Keep" : "Not now"}
						</button>
					</div>
				</section>`;
			},
		)}
	</div>`;
}
