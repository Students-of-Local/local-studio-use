import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ChevronRight } from "lucide";
import { hostConnected } from "../bridge/host-state.js";
import { allowPageScripts, pageScriptsWait, probeUserScripts } from "../browser/userscripts-status.js";
import { Toast } from "../components/Toast.js";
import { onHost } from "../site-edits/common.js";
import { guardedHosts } from "../site-edits/keeper.js";
import { type ReadyMade, readyMadeEdit, readyMadeFor } from "../site-edits/ready-made.js";
import { sitesDocument, withDocument } from "../site-edits/saved.js";
import {
	added,
	change,
	load,
	newId,
	normalizeHost,
	removed,
	type SiteEdit,
	type SiteEditsState,
	STORAGE_KEY,
	switched,
} from "../site-edits/store.js";
import { addedBy, changeDetail, changeTitle, KIND_WORDS } from "../site-edits/words.js";
import { pickElement } from "../tools/ask-user-which-element.js";

const MAX_IMPORT = 20_000_000;

/** How many scripts wait for the person, or how many changes there are: the section's state in Settings. */
export async function sitesSummary(): Promise<string> {
	const { edits } = await load();
	const waiting = edits.filter((e) => e.kind === "script" && !e.on).length;
	if (waiting) return `${waiting} waiting`;
	return edits.length ? `${edits.length} ${edits.length === 1 ? "change" : "changes"}` : "";
}

/**
 * Settings > Sites: the site in front of the person first, with its switches and its saved changes, then every other site
 * with changes as one row. Scripts waiting for an OK come before everything; a switch here and the panel's card are the
 * only ways one turns on.
 */
@customElement("site-edits-tab")
export class SiteEditsTab extends SettingsTab {
	/** Puts text in the chat input; set by the side panel. */
	onAsk?: (text: string) => void;
	@state() private state: SiteEditsState = { edits: [], adBlock: false };
	@state() private scriptsReady = true;
	/** Open sites and changes, by key. */
	@state() private open = new Set<string>();
	/** The page in the active tab, when a site edit can reach it. */
	@state() private page?: { tabId: number; url: string; host: string };
	@state() private picking = false;
	@state() private kept = false;
	private connected = false;

	private storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === "local" && changes[STORAGE_KEY]) void this.load();
	};
	private tabListener = () => void this.loadPage();

	getTabName(): string {
		return "Sites";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.connected = true;
		chrome.storage.onChanged.addListener(this.storageListener);
		chrome.tabs.onActivated.addListener(this.tabListener);
		chrome.tabs.onUpdated.addListener(this.tabListener);
		await Promise.all([this.load(), this.loadPage()]);
		this.kept = await hostConnected();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.connected = false;
		chrome.storage.onChanged.removeListener(this.storageListener);
		chrome.tabs.onActivated.removeListener(this.tabListener);
		chrome.tabs.onUpdated.removeListener(this.tabListener);
	}

	private async load() {
		this.state = await load();
		if (this.state.edits.some((e) => e.kind === "script"))
			this.scriptsReady = (await probeUserScripts()).state === "ready";
	}

	private async loadPage() {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		const url = tab?.url ?? "";
		let page: typeof this.page;
		if (tab?.id !== undefined && /^https?:/.test(url)) {
			try {
				page = { tabId: tab.id, url, host: normalizeHost(url) };
			} catch {
				// An address edits can't name (localhost, an IP address's own page, a suffix many sites share).
			}
		}
		if (this.connected && page?.url !== this.page?.url) this.page = page;
	}

	/** Straight from a click: the browser's prompt needs the gesture. */
	private async allowScripts(): Promise<void> {
		const wait = pageScriptsWait(await allowPageScripts());
		if (wait) Toast.info(wait);
		await this.load();
	}

	private async switchEdit(e: SiteEdit, on: boolean): Promise<void> {
		const asked = e.kind === "script" && on ? this.allowScripts() : undefined;
		await this.apply((s) => switched(s, e.id, on, "person"));
		await asked;
	}

	private async apply(fn: (s: SiteEditsState) => SiteEditsState): Promise<void> {
		try {
			await change((s) => ({ state: fn(s), result: undefined }));
		} catch (err) {
			Toast.error(err instanceof Error ? err.message : String(err));
			await this.load();
		}
	}

	private switchReady(ready: ReadyMade, host: string, on: boolean): Promise<void> {
		return this.apply((s) => {
			const edit = readyMadeEdit(s, ready, host);
			if (edit) return on ? switched(s, edit.id, true, "person") : removed(s, edit.id);
			if (!on) return s;
			const input = { host: ready.host ?? host, kind: ready.kind, value: ready.value, note: ready.name };
			return added(s, { ...input, actor: "person", who: "" }, newId(), Date.now()).state;
		});
	}

	private async hideSomething(page: { tabId: number; host: string }) {
		this.picking = true;
		try {
			const picked = await pickElement(page.tabId, "Click what to hide. Up and Down change the size.");
			if (!picked) return;
			const note = `Hides ${picked.label}`;
			await this.apply(
				(s) =>
					added(
						s,
						{ host: page.host, kind: "hide", value: picked.selector, note, actor: "person", who: "" },
						newId(),
						Date.now(),
					).state,
			);
		} catch (err) {
			Toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			this.picking = false;
		}
	}

	private export() {
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(sitesDocument(this.state), null, 2)], { type: "application/json" }),
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = `local-studio-sites-${new Date().toISOString().split("T")[0]}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	private import() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				if (file.size > MAX_IMPORT) throw new Error("That file is too big.");
				const doc: unknown = JSON.parse(await file.text());
				const guarded = await guardedHosts();
				const done = await change((s) => {
					const next = withDocument(s, doc, guarded, newId, Date.now());
					return { state: next?.state ?? s, result: next };
				});
				if (!done) throw new Error("That file isn't a Local Studio sites export.");
				Toast.success(`${done.added} added${done.leftOut ? `, ${done.leftOut} left out` : ""}`);
			} catch (err) {
				Toast.error(err instanceof Error ? err.message : String(err));
			}
		};
		input.click();
	}

	private toggle(key: string) {
		const next = new Set(this.open);
		if (!next.delete(key)) next.add(key);
		this.open = next;
	}

	private switchInput(label: string, checked: boolean, onChange: (on: boolean) => void): TemplateResult {
		return html`<input
			type="checkbox"
			role="switch"
			class="tk-switch"
			aria-label=${label}
			.checked=${checked}
			@change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
		/>`;
	}

	/** A saved change: its name and switch; its name opens what it does, and Remove. */
	private renderEdit(e: SiteEdit): TemplateResult {
		const key = `edit:${e.id}`;
		const shown = this.open.has(key);
		const waiting = e.kind === "script" && !e.on;
		return html`<div data-edit=${e.id}>
			<div class="flex items-center gap-2 pr-3">
				<button
					type="button"
					class="tk-row tk-row-link min-w-0 flex-1"
					aria-expanded=${shown ? "true" : "false"}
					@click=${() => this.toggle(key)}
				>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm text-foreground">${changeTitle(e)}</span>
						<span class="block truncate text-xs text-muted-foreground">${addedBy(e)} · ${waiting ? "script, waiting for you" : KIND_WORDS[e.kind].toLowerCase()}</span>
					</span>
				</button>
				${this.switchInput(`${changeTitle(e)} on ${e.host}`, e.on, (on) => void this.switchEdit(e, on))}
			</div>
			${
				shown
					? html`<div class="flex flex-col items-start gap-2 px-3 pb-3">
							${e.kind === "script" ? html`<p class="text-xs text-muted-foreground">It runs on ${e.host} after each page loads, signed in as you. Turn it on only if you'd run this code yourself.</p>` : nothing}
							<pre class="w-full max-h-48 overflow-auto rounded bg-muted p-2 text-xs text-foreground whitespace-pre-wrap break-words">${changeDetail(e)}</pre>
							<button
								type="button"
								class="h-8 rounded-md px-3 text-xs font-medium text-destructive hover:bg-destructive/10 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
								@click=${() => void this.apply((s) => removed(s, e.id))}
							>
								Remove
							</button>
						</div>`
					: nothing
			}
		</div>`;
	}

	private renderPage(page: { tabId: number; url: string; host: string }): TemplateResult {
		const ready = readyMadeFor(page.url);
		const standIns = new Set(ready.map((r) => readyMadeEdit(this.state, r, page.host)?.id));
		const saved = this.state.edits.filter((e) => onHost(page.url, e.host) && !standIns.has(e.id));
		return html`<section class="flex flex-col gap-3" data-site=${page.host} aria-labelledby="site-here">
			<h3 class="text-sm font-semibold text-foreground truncate" id="site-here">${page.host}</h3>
			<div class="tk-list">
				${ready.map(
					(r) => html`<label class="tk-row cursor-pointer">
						<span class="tk-row-name">${r.name}</span>
						${this.switchInput(`${r.name} on ${page.host}`, readyMadeEdit(this.state, r, page.host)?.on === true, (on) => void this.switchReady(r, page.host, on))}
					</label>`,
				)}
				${saved.map((e) => this.renderEdit(e))}
			</div>
			<div class="flex flex-wrap gap-2">
				${Button({ size: "sm", variant: "default", children: "Ask for a change", onClick: () => this.onAsk?.(`Change how ${page.host} looks: `) })}
				${Button({ size: "sm", variant: "outline", children: this.picking ? "Click it on the page" : "Hide something", disabled: this.picking, onClick: () => void this.hideSomething(page) })}
			</div>
		</section>`;
	}

	private renderOthers(): TemplateResult | typeof nothing {
		const url = this.page?.url;
		const hosts = [...new Set(this.state.edits.filter((e) => !onHost(url, e.host)).map((e) => e.host))].sort();
		if (!hosts.length) return nothing;
		return html`<section class="flex flex-col gap-2" aria-label="Other sites">
			<div class="tk-list">
				${hosts.map((host) => {
					const edits = this.state.edits.filter((e) => e.host === host);
					const key = `site:${host}`;
					const shown = this.open.has(key);
					return html`<div>
						<button
							type="button"
							class="tk-row tk-row-link"
							data-open=${key}
							aria-expanded=${shown ? "true" : "false"}
							@click=${() => this.toggle(key)}
						>
							<span class="tk-row-name truncate">${host}</span>
							<span class="tk-row-state">${edits.length}</span>
							<span class="tk-row-chevron ${shown ? "rotate-90" : ""}" aria-hidden="true">${icon(ChevronRight, "sm")}</span>
						</button>
						${shown ? html`<div class="tk-list-inner">${edits.map((e) => this.renderEdit(e))}</div>` : nothing}
					</div>`;
				})}
			</div>
		</section>`;
	}

	render(): TemplateResult {
		const waiting = this.state.edits.filter((e) => e.kind === "script" && !e.on && !onHost(this.page?.url, e.host));
		const anyScriptOn = this.state.edits.some((e) => e.kind === "script" && e.on);
		return html`
			<div class="flex flex-col gap-6">
				${
					waiting.length
						? html`<section class="flex flex-col gap-2" data-testid="sites-waiting">
								<h3 class="tk-group-name">Waiting for you</h3>
								<div class="tk-list">${waiting.map((e) => this.renderEdit(e))}</div>
							</section>`
						: nothing
				}
				${
					anyScriptOn && !this.scriptsReady
						? html`<div class="flex items-center justify-between gap-3" data-testid="allow-scripts">
								<p class="text-xs text-muted-foreground">Scripts need the browser's permission.</p>
								${Button({ size: "sm", variant: "secondary", children: "Allow", onClick: () => void this.allowScripts() })}
							</div>`
						: nothing
				}
				${
					this.page
						? this.renderPage(this.page)
						: html`<p class="tk-group-note">Open a site in this window to change how it looks.</p>`
				}
				${this.renderOthers()}
				<div class="tk-list">
					<label class="tk-row cursor-pointer">
						<span class="min-w-0 flex-1">
							<span class="block text-sm text-foreground">Block ads</span>
							<span class="block text-xs text-muted-foreground">Known ad networks, on every site. A site's own ads, like YouTube's, still show.</span>
						</span>
						${this.switchInput("Block ads", this.state.adBlock, (on) => void this.apply((s) => ({ ...s, adBlock: on })))}
					</label>
				</div>
				<details class="tk-more text-xs text-muted-foreground">
					<summary class="ml-3">Move or share</summary>
					<div class="mt-2 flex flex-col items-start gap-2 px-3">
						<p>
							Every change is saved in this browser${this.kept ? ", and Local Studio keeps a copy in ~/.local-studio/browser/sites.json that a new browser starts from" : ""}.
							An imported script stays off until you turn it on.
						</p>
						<div class="flex gap-2">
							${Button({ size: "sm", variant: "outline", children: "Export", disabled: !this.state.edits.length, onClick: () => this.export() })}
							${Button({ size: "sm", variant: "outline", children: "Import", onClick: () => this.import() })}
						</div>
					</div>
				</details>
			</div>
		`;
	}
}
