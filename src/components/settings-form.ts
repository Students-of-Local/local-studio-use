/** What every Settings section is made of: named groups, one card of rows each, and one line of help with the rest a click away. */

import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";

type Content = TemplateResult | TemplateResult[] | typeof nothing | string;

/** A card of rows, its name above it and a quiet line below. */
export function group(name: string, rows: unknown, note: Content = nothing): TemplateResult {
	return html`<section class="flex flex-col gap-1.5" aria-label=${name || nothing}>
		${name ? html`<h3 class="tk-group-name">${name}</h3>` : nothing}
		<div class="tk-list">${rows}</div>
		${note === nothing ? nothing : html`<div class="tk-group-note">${note}</div>`}
	</section>`;
}

/** A row's name and, under it, what it does in one line. */
export function rowText(name: Content, help: Content = nothing): TemplateResult {
	return html`<span class="min-w-0 flex-1">
		<span class="block text-sm font-medium text-foreground">${name}</span>
		${help === nothing || help === "" ? nothing : html`<span class="block text-xs text-muted-foreground">${help}</span>`}
	</span>`;
}

/** The whole explanation, one click away. */
export function more(summary: string, detail: Content): TemplateResult {
	return html`<details class="tk-more text-xs text-muted-foreground">
		<summary>${summary}</summary>
		<div class="mt-1">${detail}</div>
	</details>`;
}

export interface SwitchRow {
	name: string;
	help?: Content;
	on: boolean;
	set: (on: boolean) => void;
	/** Greyed out and locked. */
	off?: boolean;
	/** What opens under the row. */
	more?: Content;
}

export function switchRow(row: SwitchRow): TemplateResult {
	return html`<div class=${row.off ? "opacity-50" : ""}>
		<label class="tk-row ${row.off ? "" : "cursor-pointer"}">
			${rowText(row.name, row.help)}
			<input
				type="checkbox"
				role="switch"
				class="tk-switch"
				.checked=${live(row.on)}
				?disabled=${row.off}
				@change=${(e: Event) => row.set((e.target as HTMLInputElement).checked)}
			/>
		</label>
		${row.more ? html`<div class="tk-row-more">${row.more}</div>` : nothing}
	</div>`;
}

/** One of several: the whole row picks it. */
export function choiceRow(name: string, value: string, label: string, help: string, on: boolean, set: () => void) {
	return html`<label class="tk-row cursor-pointer">
		${rowText(label, help)}
		<input type="radio" name=${name} value=${value} .checked=${live(on)} @change=${set} />
	</label>`;
}
