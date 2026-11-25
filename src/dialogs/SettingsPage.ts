import { i18n } from "@mariozechner/mini-lit";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import type { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight, type IconNode } from "lucide";
import { PageBase } from "../components/PageBase.js";

export interface SettingsSection {
	/** The row's text and the section's title. */
	name: string;
	icon: IconNode;
	tab: SettingsTab;
	/** A short state for the row ("Connected"). It draws when it is known; an empty one draws nothing. */
	state?: () => string | Promise<string>;
}

/**
 * Settings as a page that fills the side panel: a short list of sections, each opening over the list. Back and Esc go
 * from a section to the list and from the list to the chat; a section opened straight from the chat goes back to it.
 * A section is mounted the first time it opens, and kept, so a half-typed field survives a look at another section.
 */
export class SettingsPage extends PageBase {
	private groups: SettingsSection[][] = [];
	private active?: string;
	/** Sections opened so far. */
	private mounted = new Set<string>();
	/** Opened straight to a section: Back returns to the chat. */
	private direct = false;
	private states = new Map<string, string>();

	/** The open Settings page, or a new one with these groups; `show` opens it on that section. */
	static open(groups: SettingsSection[][], show?: { tab: string; anchor?: string }): SettingsPage {
		const current = document.querySelector<SettingsPage>("local-studio-settings");
		if (current) return current;
		const page = new SettingsPage();
		page.groups = groups;
		if (show) {
			page.direct = true;
			page.showTab(show.tab, show.anchor);
		}
		page.open();
		return page;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.readStates();
	}

	private sections(): SettingsSection[] {
		return this.groups.flat();
	}

	private readStates(): void {
		for (const section of this.sections()) {
			if (!section.state) continue;
			void Promise.resolve()
				.then(section.state)
				.then((text) => {
					if (this.states.get(section.name) === text) return;
					this.states.set(section.name, text);
					this.requestUpdate();
				})
				.catch((error) => console.warn(`Settings > ${section.name}: no state`, error));
		}
	}

	/** Show the section with this name, and scroll to the element with `anchor` inside it when given. */
	showTab(name: string, anchor?: string): void {
		if (!this.sections().some((section) => section.name === name)) return;
		this.active = name;
		this.mounted.add(name);
		this.requestUpdate();
		void this.updateComplete.then(() => {
			this.querySelector(".tk-page-body")?.scrollTo(0, 0);
			// The section's content renders after it is shown; look for the anchor once it has.
			if (!anchor) return;
			(
				this.sections().find((section) => section.name === name)?.tab as { openAnchor?(anchor: string): void }
			).openAnchor?.(anchor);
			requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
		});
	}

	protected override async back(): Promise<void> {
		if (this.active === undefined || this.direct) return this.close();
		const from = this.active;
		this.active = undefined;
		this.readStates();
		this.requestUpdate();
		await this.updateComplete;
		this.querySelector<HTMLElement>(`[data-section="${from}"]`)?.focus();
	}

	protected pageTitle(): string {
		return this.active ?? i18n("Settings");
	}

	private renderRow(section: SettingsSection): TemplateResult {
		const state = this.states.get(section.name);
		return html`
			<button
				type="button"
				class="tk-row tk-row-link"
				data-section=${section.name}
				@click=${() => {
					this.showTab(section.name);
					this.querySelector<HTMLElement>("[data-page-back]")?.focus();
				}}
			>
				<span class="tk-row-icon" aria-hidden="true">${icon(section.icon, "sm")}</span>
				<span class="tk-row-name">${section.name}</span>
				${state ? html`<span class="tk-row-state">${state}</span>` : nothing}
				<span class="tk-row-chevron" aria-hidden="true">${icon(ChevronRight, "sm")}</span>
			</button>
		`;
	}

	protected override fillsHeight = true;

	protected renderContent(): TemplateResult {
		return html`
			<div class="tk-page-body min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto max-w-2xl px-4 py-4">
					<nav class="flex flex-col gap-4" aria-label="Settings sections" ?hidden=${this.active !== undefined}>
						${this.groups.map((group) => html`<div class="tk-list">${group.map((section) => this.renderRow(section))}</div>`)}
					</nav>
					${this.sections()
						.filter((section) => this.mounted.has(section.name))
						.map(
							(section) =>
								html`<div data-panel=${section.name} role="region" aria-label=${section.name} ?hidden=${this.active !== section.name}>
									${section.tab}
								</div>`,
						)}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("local-studio-settings")) customElements.define("local-studio-settings", SettingsPage);
