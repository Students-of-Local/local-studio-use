import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
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
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
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

	private renderUserScripts(): TemplateResult {
		const status = this.userScripts;
		if (!status) return html``;
		const line = (text: string) => html`<div class="text-xs text-muted-foreground">${text}</div>`;
		/** The detail stays one click away, for the person who needs the browser's own wording. */
		const details = (text: string) => html`
			<details class="text-xs text-muted-foreground">
				<summary class="cursor-pointer text-foreground">Details</summary>
				<p class="mt-1">${text}</p>
			</details>
		`;
		let body: TemplateResult;
		switch (status.state) {
			case "ready":
				body = html`${line("On: agents' page scripts run faster.")}${details("Agents run page scripts through the browser's userScripts API.")}`;
				break;
			case "not_granted":
				body = html`
					${line("Turning this on makes agents' page scripts run faster.")}
					<div>${Button({ size: "sm", variant: "secondary", children: "Allow", onClick: () => this.grantUserScripts() })}</div>
					${details(
						'Local Studio has not been granted the userScripts permission. The "Allow user scripts" toggle on the extension\'s Details page is not enough on its own. Without it, page scripts run through the debugger, which is slower.',
					)}
				`;
				break;
			case "toggle_off":
				body = html`
					${line("Page scripts are slower than they could be: one more switch is needed in the browser.")}
					${details(
						status.apiPresent
							? 'The permission is granted, but "Allow user scripts" is off. Turn it on at chrome://extensions > Local Studio > Details.'
							: userScriptsHiddenHelp(runningFromStore(), hostCommand()),
					)}
				`;
				break;
			case "probe_error":
				body = line(`Couldn't check: ${status.error ?? "unknown error"}`);
				break;
		}
		return html`
			<div class="space-y-2" data-page-scripts>
				<h3 class="text-sm font-semibold text-foreground">Page scripts</h3>
				${body}
				${this.userScriptsNote ? line(this.userScriptsNote) : ""}
			</div>
		`;
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

	/** A setting with a line of help and a switch; `off` greys it out and locks it. */
	private switchRow(title: string, help: string, checked: boolean, set: (on: boolean) => Promise<void>, off = false) {
		return html`<label
			class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer ${off ? "opacity-50" : ""}"
		>
			<span class="space-y-1">
				<span class="block">${title}</span>
				${help ? html`<span class="block text-xs text-muted-foreground">${help}</span>` : ""}
			</span>
			<input
				type="checkbox"
				role="switch"
				class="tk-switch"
				.checked=${live(checked)}
				?disabled=${off}
				@change=${async (e: Event) => {
					const on = (e.target as HTMLInputElement).checked;
					await saveSwitch(
						() => set(on),
						() => this.requestUpdate(),
						`"${title}"`,
						(m) => Toast.error(m),
					);
					await this.load();
				}}
			/>
		</label>`;
	}

	private heading(text: string): TemplateResult {
		return html`<h3 class="text-sm font-semibold text-foreground">${text}</h3>`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<div class="flex flex-col gap-3">
					<p class="text-sm text-foreground" role="status" data-helper-setup=${this.connected ? "connected" : "missing"}>
						${
							this.connected
								? "Connected. Agents on this computer can use this browser, each in its own tab group."
								: html`Not connected.
										<a class="underline underline-offset-2" href=${APP_DOWNLOAD_URL} target="_blank" rel="noopener" data-get-app
											>Get Local Studio</a
										>
										and turn on Browser use in its Settings, or give the setup prompt to your agent.`
						}
					</p>
					${agentSetupPromptButton()}
					${this.switchRow("Allow external agents to use the browser", "", this.enabled, setBridgeEnabled)}
				</div>

				${
					this.pending.length > 0
						? html`
							<div class="space-y-2">
								${this.heading("Waiting for your answer")}
								${this.askCards(this.pending, (p, d) => this.decide(p, d))}
							</div>
						`
						: ""
				}

				<div class="flex flex-col gap-2" role="radiogroup" aria-label="Permission mode">
					${this.heading("When they ask")}
					${MODE_CHOICES.map(
						(m) => html`<label class="flex items-start gap-2 text-sm text-foreground cursor-pointer">
							<input type="radio" class="mt-1" name="bridge-mode" value=${m.mode} .checked=${this.mode === m.mode} @change=${async () => {
								await setPermissionMode(m.mode);
								await this.load();
							}} />
							<span>
								<span class="block font-medium">${m.title}</span>
								<span class="block text-xs text-muted-foreground">${m.short}</span>
							</span>
						</label>`,
					)}
					<details class="tk-more text-xs text-muted-foreground">
						<summary>What each one allows</summary>
						<ul class="mt-1.5 flex list-none flex-col gap-1.5">
							${MODE_CHOICES.map((m) => html`<li><span class="font-medium text-foreground">${m.title}</span>: ${m.help}</li>`)}
						</ul>
					</details>
				</div>

				<div class="space-y-2">
					${this.heading("Allowed sites")}
					${
						this.hosts.length === 0
							? ""
							: this.hosts.map(
									(h) => html`
										<div class="flex items-center justify-between gap-2 text-sm">
											<span class="min-w-0 break-all font-mono text-foreground">${h}</span>
											${Button({
												size: "sm",
												variant: "ghost",
												children: "Remove",
												onClick: async () => {
													await revokeHost(h);
													await this.load();
												},
											})}
										</div>
									`,
								)
					}
					<div class="flex gap-2 items-center">
						${Input({
							placeholder: "example.com and its subdomains",
							value: this.newHost,
							className: "text-sm flex-1",
							onInput: (e: Event) => {
								this.newHost = (e.target as HTMLInputElement).value;
								this.newHostError = "";
							},
							onKeyDown: (e: KeyboardEvent) => {
								if (e.key === "Enter") this.addHost();
							},
						})}
						${Button({ size: "sm", variant: "secondary", children: "Add", onClick: () => this.addHost() })}
					</div>
					${this.newHostError ? html`<div class="text-xs text-destructive" role="alert">${this.newHostError}</div>` : ""}
				</div>

				<div class="flex flex-col gap-3">
					${this.heading("On screen")}
					${this.switchRow(
						"Show when an agent is using a tab",
						"A glow and a label; Take over in the label gives you the tab back.",
						this.veil,
						setVeilEnabled,
					)}
					${this.switchRow(
						"Show the agent's pointer",
						"Moves to what the agent clicks. It never takes your clicks.",
						this.pointer,
						setPointerEnabled,
						!this.veil,
					)}
				</div>

				${this.renderUserScripts()}

				${
					this.sessions.length === 0
						? ""
						: html`<div class="space-y-2">
								${this.heading("Agent sessions in this browser")}
								${this.sessions.map(
									(s) =>
										html`<div class="text-sm text-foreground">${s.label} <span class="text-muted-foreground">(${s.tabs} tab${s.tabs === 1 ? "" : "s"})</span></div>`,
								)}
							</div>`
				}
			</div>
		`;
	}
}
