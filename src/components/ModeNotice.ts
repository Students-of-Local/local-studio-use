/**
 * The one-time notice under the side panel header for an install the migration put in Auto without its owner choosing
 * it (docs/decisions.md, D67): what changed, and one click back to Manual. `getPermissionMode` leaves the notice in
 * storage; choosing any mode, or dismissing it, takes it away for good.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
	dismissModeNotice,
	getModeNotice,
	getPermissionMode,
	MODE_NOTICE_KEY,
	type ModeNotice,
	setPermissionMode,
} from "../bridge/permissions.js";

let notice: ModeNotice | undefined;
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

/** Load the notice and call `onChange` whenever it changes. Reading the mode here runs the migration on first open. */
export async function watchModeNotice(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= getPermissionMode()
		.then(() => getModeNotice())
		.then((value) => {
			notice = value;
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area !== "local" || !(MODE_NOTICE_KEY in changes)) return;
				notice = changes[MODE_NOTICE_KEY].newValue as ModeNotice | undefined;
				for (const l of listeners) l();
			});
		});
	await loading;
	onChange();
	return () => listeners.delete(onChange);
}

/** Act, then take the card down at once: the storage event that would do it comes a moment later. */
async function answer(act: () => Promise<void>): Promise<void> {
	await act();
	notice = undefined;
	for (const l of listeners) l();
}

/** The text of the notice, for the card and its test. */
export const MODE_NOTICE_TEXT =
	"Local Studio is now in Auto mode: agents on frontier models open ordinary sites on their own, small or unknown models ask you first, and every agent asks before it goes straight to mail, a bank or another sensitive site you haven't allowed.";

export function modeNotice(): TemplateResult | typeof nothing {
	if (!notice) return nothing;
	return html`<section
		class="mx-3 my-2 rounded-lg border border-border bg-card p-3 text-xs space-y-2 shrink-0"
		aria-label="Permission mode"
		data-testid="mode-notice"
	>
		<p class="text-sm text-foreground">${MODE_NOTICE_TEXT}</p>
		<p class="text-muted-foreground">Manual asks before every new site. Settings &gt; Agents has all three modes.</p>
		<div class="flex gap-2 flex-wrap">
			<button
				class="rounded-md border border-border px-2 py-1 text-foreground hover:bg-secondary"
				@click=${() => answer(() => setPermissionMode("manual"))}
			>
				Switch to Manual
			</button>
			<button class="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground" @click=${() => answer(dismissModeNotice)}>
				Keep Auto
			</button>
		</div>
	</section>`;
}
