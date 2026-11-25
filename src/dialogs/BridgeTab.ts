import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { hostCommand } from "../bridge/host-command.js";
import { hostConnected } from "../bridge/host-state.js";
import {
	allowHost,
	getAllowedHosts,
	getPendingRequests,
	getPermissionMode,
	isBridgeEnabled,
	normalizeHostInput,
	type PendingRequest,
	type PermissionMode,
	recordDecision,
	revokeHost,
	setBridgeEnabled,
	setPermissionMode,
} from "../bridge/permissions.js";
import type { UserScriptsStatus } from "../bridge/protocol.js";
import { listSessions } from "../browser/session.js";
import { probeUserScripts, userScriptsHiddenHelp } from "../browser/userscripts-status.js";
import { isPointerEnabled, isVeilEnabled, setPointerEnabled, setVeilEnabled } from "../browser/veil-shared.js";
import { askCards } from "../components/AgentAsks.js";
import { agentSetupPromptRow } from "../components/AgentSetupPrompt.js";
import { choiceRow, group, more, rowText, switchRow } from "../components/settings-form.js";
import { Toast } from "../components/Toast.js";
import { APP_DOWNLOAD_URL } from "../release-source.js";
import { runningFromStore } from "../update/store-install.js";
import { saveSwitch } from "./switch-save.js";

/**
 * Settings > Agents: who may drive the browser from outside (omp, pi, Claude
 * Code, Codex through `local-studio-browser mcp`), which hosts they may open, and pending
 * permission requests.
 */
/** The three modes as Settings > Agents offers them (D67), in this order. */
export const MODE_CHOICES: ReadonlyArray<{ mode: PermissionMode; title: string; short: string; help: string }> = [
	{
		mode: "manual",
		title: "Manual",
		short: "Asks before any site you haven't allowed",
		help: "agents ask before opening any site you haven't allowed",
	},
	{
		mode: "auto",
		title: "Auto (default)",
		short: "Asks before mail, banks and other sensitive sites",
		help: "agents on frontier models open ordinary sites; small or unknown models ask first. Every agent asks before it goes straight to mail, a bank or another sensitive site you haven't allowed (a link it clicks there isn't checked)",
	},
	{
		mode: "yolo",
		title: "Yolo",
		short: "Never asks",
		help: "nothing asks: agents open any site except the extension's own pages, its approval page and the helper's local services",
	},
];

@customElement("bridge-tab")
export class BridgeTab extends SettingsTab {
	@state() private enabled = true;
	@state() private connected = false;
	@state() private veil = true;
	@state() private pointer = true;
	@state() private mode: PermissionMode = "auto";
	@state() private hosts: string[] = [];
	@state() private pending: PendingRequest[] = [];
	private askCards = askCards();
	@state() private sessions: Array<{ id: string; label: string; tabs: number }> = [];
	@state() private newHost = "";
	@state() private newHostError = "";
	@state() private userScripts?: UserScriptsStatus;
	@state() private userScriptsNote = "";

	private storageListener = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area === "session" || area === "local") this.load();
	};

	getTabName(): string {
		return "Agents";
	}

	private permissionListener = () => this.load();

	override async connectedCallback() {
		super.connectedCallback();
		chrome.storage.onChanged.addListener(this.storageListener);
		chrome.permissions.onAdded.addListener(this.permissionListener);
		chrome.permissions.onRemoved.addListener(this.permissionListener);
		await this.load();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		chrome.storage.onChanged.removeListener(this.storageListener);
		chrome.permissions.onAdded.removeListener(this.permissionListener);
		chrome.permissions.onRemoved.removeListener(this.permissionListener);
	}

	private async load() {
		this.enabled = await isBridgeEnabled();
		this.connected = await hostConnected();
		this.veil = await isVeilEnabled();
		this.pointer = await isPointerEnabled();
		this.mode = await getPermissionMode();
		this.hosts = await getAllowedHosts();
		this.pending = await getPendingRequests();
		this.sessions = (await listSessions())
			.filter((s) => s.id.startsWith("bridge-"))
			.map((s) => ({ id: s.id, label: s.label, tabs: s.tabIds.length }));
		const userScripts = await probeUserScripts();
		// A note answers one click; it goes once the state moves on.
		if (userScripts.state !== this.userScripts?.state) this.userScriptsNote = "";
		this.userScripts = userScripts;
	}

	/**
	 * Called straight from the click: chrome.permissions.request must be the first await to keep
	 * the user gesture. No extension reload here: that would cut off every agent session.
	 */
	private async grantUserScripts() {
		let note = "";
		try {
			const granted = await chrome.permissions.request({ permissions: ["userScripts"] });
			if (!granted) note = "The browser did not grant the permission. Click Allow again and accept the prompt.";
		} catch (err) {
			note = `Couldn't ask for the permission: ${err instanceof Error ? err.message : String(err)}`;
		}
		await this.load();
		this.userScriptsNote = note;
	}

	/** Faster page scripts need the browser's own permission; the browser's wording stays one click away. */
	private renderUserScripts(): TemplateResult | typeof nothing {
		const status = this.userScripts;
		if (!status) return nothing;
		const row = (help: string, act: TemplateResult | typeof nothing, detail: string) =>
			html`<div data-page-scripts>
				<div class="tk-row">${rowText("Page scripts", help)} ${act}</div>
				<div class="tk-row-more">
					${this.userScriptsNote ? html`<p class="text-xs text-foreground" role="status">${this.userScriptsNote}</p>` : nothing}
					${detail ? more("Details", detail) : nothing}
				</div>
			</div>`;
		switch (status.state) {
			case "ready":
				return row(
					"On: agents' page scripts run faster.",
					nothing,
					"Agents run page scripts through the browser's userScripts API.",
				);
			case "not_granted":
				return row(
					"Turning this on makes agents' page scripts run faster.",
					html`<button type="button" class="tk-row-button" @click=${() => this.grantUserScripts()}>Allow</button>`,
					'Local Studio has not been granted the userScripts permission. The "Allow user scripts" toggle on the extension\'s Details page is not enough on its own. Without it, page scripts run through the debugger, which is slower.',
				);
			case "toggle_off":
				return row(
					"Slower than they could be: one more switch is needed in the browser.",
					nothing,
					status.apiPresent
						? 'The permission is granted, but "Allow user scripts" is off. Turn it on at chrome://extensions > Local Studio > Details.'
						: userScriptsHiddenHelp(runningFromStore(), hostCommand()),
				);
			case "probe_error":
				return row(`Couldn't check: ${status.error ?? "unknown error"}`, nothing, "");
		}
	}

	private async decide(request: PendingRequest, decision: "allow_once" | "allow_host" | "deny") {
		await recordDecision(request.requestId, decision);
		await this.load();
	}

	private async addHost() {
		if (!this.newHost.trim()) return;
		const result = normalizeHostInput(this.newHost);
		if ("error" in result) {
			this.newHostError = result.error;
			return;
		}
		await allowHost(result.host);
		this.newHost = "";
		this.newHostError = "";
		await this.load();
	}

	private switchRow(name: string, help: string, on: boolean, set: (on: boolean) => Promise<void>, off = false) {
		return switchRow({
			name,
			help,
			on,
			off,
			set: async (value) => {
				await saveSwitch(
					() => set(value),
					() => this.requestUpdate(),
					`"${name}"`,
					(m) => Toast.error(m),
				);
				await this.load();
			},
		});
	}

	private renderHelper(): TemplateResult {
		return html`<div class="tk-row" role="status" data-helper-setup=${this.connected ? "connected" : "missing"}>
			${
				this.connected
					? rowText("Connected", "Each agent works in its own tab group")
					: html`${rowText("Not connected", "Turn on Browser use in the Local Studio app")}
							<a class="tk-row-button" href=${APP_DOWNLOAD_URL} target="_blank" rel="noopener" data-get-app>Get the app</a>`
			}
		</div>`;
	}

	private renderHosts(): TemplateResult {
		return group(
			"Allowed sites",
			html`${this.hosts.map(
				(h) => html`<div class="tk-row">
					<span class="min-w-0 flex-1 break-all text-sm text-foreground">${h}</span>
					<button
						type="button"
						class="tk-row-quiet"
						aria-label=${`Remove ${h}`}
						@click=${async () => {
							await revokeHost(h);
							await this.load();
						}}
					>
						Remove
					</button>
				</div>`,
			)}
				<div class="tk-row">
					<input
						class="tk-row-input"
						aria-label="Allow a site"
						placeholder="example.com and its subdomains"
						.value=${live(this.newHost)}
						@input=${(e: Event) => {
							this.newHost = (e.target as HTMLInputElement).value;
							this.newHostError = "";
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === "Enter") void this.addHost();
						}}
					/>
					<button type="button" class="tk-row-button" ?disabled=${!this.newHost.trim()} @click=${() => this.addHost()}>Add</button>
				</div>`,
			this.newHostError ? html`<p class="text-destructive" role="alert">${this.newHostError}</p>` : nothing,
		);
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-5">
				${group(
					"",
					html`${this.renderHelper()} ${agentSetupPromptRow()}
					${this.switchRow("Allow agents to use the browser", "", this.enabled, setBridgeEnabled)}`,
				)}
				${
					this.pending.length > 0
						? html`<section class="flex flex-col gap-1.5">
								<h3 class="tk-group-name">Waiting for your answer</h3>
								${this.askCards(this.pending, (p, d) => this.decide(p, d))}
							</section>`
						: ""
				}
				<div role="radiogroup" aria-label="Permission mode">
					${group(
						"When they ask",
						MODE_CHOICES.map((m) =>
							choiceRow("bridge-mode", m.mode, m.title, m.short, this.mode === m.mode, async () => {
								await setPermissionMode(m.mode);
								await this.load();
							}),
						),
						more(
							"What each one allows",
							html`<ul class="flex list-none flex-col gap-1.5">
								${MODE_CHOICES.map((m) => html`<li><span class="font-medium text-foreground">${m.title}</span>: ${m.help}</li>`)}
							</ul>`,
						),
					)}
				</div>
				${this.renderHosts()}
				${group(
					"In the browser",
					html`${this.switchRow(
						"Show when an agent is using a tab",
						"A glow, and Take over to get the tab back",
						this.veil,
						setVeilEnabled,
					)}
					${this.switchRow(
						"Show the agent's pointer",
						"Moves to what the agent clicks, never takes your clicks",
						this.pointer,
						setPointerEnabled,
						!this.veil,
					)}
					${this.renderUserScripts()}`,
				)}
				${
					this.sessions.length === 0
						? ""
						: group(
								"Working now",
								this.sessions.map(
									(s) => html`<div class="tk-row">
										<span class="tk-row-name">${s.label}</span>
										<span class="tk-row-state">${s.tabs} tab${s.tabs === 1 ? "" : "s"}</span>
									</div>`,
								),
							)
				}
			</div>
		`;
	}
}
