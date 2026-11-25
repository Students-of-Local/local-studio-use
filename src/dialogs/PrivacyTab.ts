import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { hostCommand } from "../bridge/host-command.js";
import { Toast } from "../components/Toast.js";
import { MODELS_DEV_KEY } from "../models/registry.js";
import { BUG_LOG_KEY, BUG_REPORTS_KEY, type BugEntry, NEW_ISSUE_URL, reportText } from "../privacy/bug-reports.js";
import { setBugReports } from "../privacy/capture.js";
import { hostOf, PRIVATE_MODE_KEY, TRUSTED_HOSTS_KEY } from "../privacy/private-mode.js";
import { getLocalStudioStorage } from "../storage/app-storage.js";
import { CHAT_SYNC_KEY, MIRROR_KEY } from "../threads/keys.js";
import { SHARE_OLDER_KEY, SHARED_SINCE_KEY } from "../threads/store.js";
import { saveSwitch } from "./switch-save.js";

/** One plain sentence stays visible; the full explanation is one click away and unchanged. */
function explained(summary: string, more: string, detail: TemplateResult | string): TemplateResult {
	return html`
		<p class="text-xs text-muted-foreground">${summary}</p>
		<details class="tk-more text-xs text-muted-foreground">
			<summary>${more}</summary>
			<p class="mt-1">${detail}</p>
		</details>
	`;
}

/** Settings > Privacy: private mode, the hosts the user trusts as their own, models.dev lookups and opt-in bug reports. */
@customElement("local-studio-privacy-tab")
export class PrivacyTab extends SettingsTab {
	@state() private privateMode = false;
	@state() private trustedHosts = "";
	@state() private bugReports = false;
	@state() private mirror = true;
	@state() private sync = true;
	@state() private modelsDev = true;
	@state() private shareOlder = false;
	@state() private sharedSince = "";
	@state() private log: BugEntry[] = [];
	/** The report as the user will share it; shown and editable before anything leaves. */
	@state() private draft: string | undefined;

	getTabName(): string {
		return "Privacy";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getLocalStudioStorage().settings;
		this.privateMode = (await settings.get<boolean>(PRIVATE_MODE_KEY)) === true;
		this.trustedHosts = ((await settings.get<string[]>(TRUSTED_HOSTS_KEY)) ?? []).join(", ");
		this.bugReports = (await settings.get<boolean>(BUG_REPORTS_KEY)) === true;
		this.modelsDev = (await settings.get<boolean>(MODELS_DEV_KEY)) !== false;
		this.log = (await settings.get<BugEntry[]>(BUG_LOG_KEY)) ?? [];
		const threads = await chrome.storage.local.get([MIRROR_KEY, CHAT_SYNC_KEY, SHARE_OLDER_KEY, SHARED_SINCE_KEY]);
		this.mirror = threads[MIRROR_KEY] !== false;
		this.sync = threads[CHAT_SYNC_KEY] !== false;
		this.shareOlder = threads[SHARE_OLDER_KEY] === true;
		this.sharedSince = typeof threads[SHARED_SINCE_KEY] === "string" ? threads[SHARED_SINCE_KEY] : "";
	}

	private save(write: () => Promise<unknown>, what: string): Promise<boolean> {
		return saveSwitch(
			write,
			() => this.requestUpdate(),
			what,
			(m) => Toast.error(m),
		);
	}

	/** Chats from before agent access began may be private-mode chats saved without the mark. */
	private async setShareOlder(on: boolean) {
		if (await this.save(() => chrome.storage.local.set({ [SHARE_OLDER_KEY]: on }), "older chats"))
			this.shareOlder = on;
	}

	/** The local thread mirror; the worker writes it (on) or removes it (off) when this changes. */
	private async setMirror(on: boolean) {
		if (await this.save(() => chrome.storage.local.set({ [MIRROR_KEY]: on }), "past chats for coding agents"))
			this.mirror = on;
	}

	/** One set of chats with the Local Studio app (src/threads/sync.ts). */
	private async setSync(on: boolean) {
		if (await this.save(() => chrome.storage.local.set({ [CHAT_SYNC_KEY]: on }), "chats in Local Studio"))
			this.sync = on;
	}

	private async setModelsDev(on: boolean) {
		if (await this.save(() => getLocalStudioStorage().settings.set(MODELS_DEV_KEY, on), "model details"))
			this.modelsDev = on;
	}

	private async setPrivateMode(on: boolean) {
		if (await this.save(() => getLocalStudioStorage().settings.set(PRIVATE_MODE_KEY, on), "Private mode"))
			this.privateMode = on;
	}

	private async saveTrustedHosts(text: string) {
		// Names, IPs, URLs and host:port all reduce to the host; anything else is dropped.
		const hosts = [
			...new Set(
				text
					.split(/[\s,]+/)
					.map(hostOf)
					.filter((h): h is string => Boolean(h)),
			),
		];
		await getLocalStudioStorage().settings.set(TRUSTED_HOSTS_KEY, hosts);
		this.trustedHosts = hosts.join(", ");
	}

	private async setBugReports(on: boolean) {
		if (!(await this.save(() => setBugReports(getLocalStudioStorage(), on), "bug reports"))) return;
		this.bugReports = on;
		if (!on) {
			this.log = [];
			this.draft = undefined;
		}
	}

	private async copyAndOpen() {
		try {
			await navigator.clipboard.writeText(this.draft ?? "");
		} catch {
			Toast.error("Couldn't copy the report. Select the text and copy it yourself.");
			return;
		}
		// A blank issue page: nothing of the report is in the address.
		window.open(NEW_ISSUE_URL, "_blank", "noopener");
		Toast.success("Report copied. Paste it into the GitHub issue; nothing is sent until you submit there.");
	}

	render(): TemplateResult {
		const version = chrome.runtime.getManifest().version;
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Only use models that don't keep my prompts</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${live(this.privateMode)}
							@change=${(e: Event) => this.setPrivateMode((e.target as HTMLInputElement).checked)}
						/>
					</label>
					${explained(
						"Your prompts go only to models that promise not to keep them, or to machines of your own.",
						"How private mode works",
						`The side panel agent then runs only OpenRouter models, sent with zero data retention required and no
						fallback to other endpoints, and models on this computer or on the hosts you list below (a LAN or tailnet
						machine counts only once you list it). Free mode then uses only free models with zero data retention, and
						refuses to send when none is available. A local server that forwards to a cloud service (for example an
						Ollama cloud model) is still a cloud service: don't use one in private mode.
						Other providers, and a CORS proxy that isn't on those machines, are refused. This covers the side panel
						agent; an outside agent using the Bridge follows its own settings.`,
					)}
					<div class="flex flex-col gap-1">
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">
							<span>Your own machines, comma-separated.</span>
							<input
								class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								placeholder="mac.example.ts.net, nas.local"
								.value=${this.trustedHosts}
								@change=${(e: Event) => this.saveTrustedHosts((e.target as HTMLInputElement).value)}
							/>
						</label>
						<details class="tk-more text-xs text-muted-foreground">
							<summary>What counts as your own</summary>
							<p class="mt-1">Prefer names over IPs (for example mac.example.ts.net): a listed IP is trusted on every network, including one where it belongs to someone else.</p>
						</details>
					</div>
				</div>

				<div class="space-y-2">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Look up model details on models.dev</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${live(this.modelsDev)}
							@change=${(e: Event) => this.setModelsDev((e.target as HTMLInputElement).checked)}
						/>
					</label>
					${explained(
						"Fills in prices and limits for models your API keys list. It sends no key, chat or page.",
						"What is fetched",
						`When you have an API key for a provider that lists its models, Local Studio downloads the public model
						table at https://models.dev/api.json when its copy is a day old or missing, to fill in names, prices and context
						limits the provider leaves out. models.dev sees your IP address, as any site does. Off: models.dev is never asked; Local Studio uses the provider's own
						details, its built-in table and a copy it downloaded earlier, if any.`,
					)}
				</div>

				<div class="space-y-2">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Same chats here and in the Local Studio app</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${live(this.sync)}
							@change=${(e: Event) => this.setSync((e.target as HTMLInputElement).checked)}
						/>
					</label>
					${explained(
						"On by default. Start a chat in either one and go on with it in the other.",
						"What is kept where",
						`Your side panel chats are written to the Local Studio app's threads on this computer, what you add in the app
						comes back here, and the app's own threads show under Past chats. Nothing is uploaded. Chats made in private mode
						are never written, keys pasted into a chat and the model's reasoning are left out, and threads you
						keep local-only in the app don't show here. Turning this off stops both ways; chats the app already has stay
						there.`,
					)}
				</div>

				<div class="space-y-2">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Let my coding agents read my past chats</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${live(this.mirror)}
							@change=${(e: Event) => this.setMirror((e.target as HTMLInputElement).checked)}
						/>
					</label>
					${
						this.mirror && this.sharedSince
							? html`<label class="flex items-start justify-between gap-3 text-sm text-foreground cursor-pointer">
								<span
									>Also chats from before ${new Date(this.sharedSince).toLocaleDateString()} (older versions didn't mark
									private-mode chats, so check none of those were private)</span
								>
								<input
									type="checkbox"
									role="switch"
									class="tk-switch"
									.checked=${live(this.shareOlder)}
									@change=${(e: Event) => this.setShareOlder((e.target as HTMLInputElement).checked)}
								/>
							</label>`
							: ""
					}
					${explained(
						"On by default. Keeps a copy of your chats on this computer so your coding agents can look up past chats.",
						"What is copied, and where",
						`Keeps a copy of your side panel chats in ~/.local/share/local-studio-browser/threads (readable only by your user), so
						agents like Claude Code and Codex can look up past chats, through the MCP server or as files. The copy is not
						uploaded, but an agent that reads it may send it to its own AI.
						Keys pasted into a chat are removed from the copy, and chats marked private are never copied. Turning
						this off deletes the copy and stops agents reading past chats. Agents connected through ${hostCommand()} serve need a token with the threads.read scope.`,
					)}
				</div>

				<div class="space-y-2">
					<label class="flex items-start justify-between gap-3 text-sm font-medium text-foreground cursor-pointer">
						<span>Keep error reports so I can send them</span>
						<input
							type="checkbox"
							role="switch"
							class="tk-switch"
							.checked=${live(this.bugReports)}
							@change=${(e: Event) => this.setBugReports((e.target as HTMLInputElement).checked)}
						/>
					</label>
					${explained(
						"Optional and off by default. Nothing is sent unless you send it.",
						"What a report holds",
						`Optional and off by default. Errors are kept in this browser with web addresses, emails and keys removed.
						Nothing is sent: you review the report here, copy it, and paste it into a GitHub issue yourself.`,
					)}
					${
						this.bugReports
							? this.draft === undefined
								? html`<div class="flex items-center gap-3">
										${Button({
											size: "sm",
											variant: "secondary",

											onClick: async () => {
												// Read the log fresh: errors may have arrived while this tab was open.
												this.log =
													(await getLocalStudioStorage().settings.get<BugEntry[]>(BUG_LOG_KEY)) ?? [];
												this.draft = reportText(version, this.log, navigator.userAgent);
											},
											children: "Review report",
										})}
										<span class="text-xs text-muted-foreground">${this.log.length} error${this.log.length === 1 ? "" : "s"} kept</span>
									</div>`
								: html`<div class="flex flex-col gap-2">
										<textarea
											class="h-48 w-full rounded border border-border bg-background p-2 font-mono text-xs text-foreground"
											.value=${this.draft}
											@input=${(e: Event) => {
												this.draft = (e.target as HTMLTextAreaElement).value;
											}}
										></textarea>
										<div class="flex gap-2">
											${Button({ size: "sm", variant: "default", onClick: () => this.copyAndOpen(), children: "Copy and open GitHub" })}
											${Button({
												size: "sm",
												variant: "ghost",
												onClick: () => {
													this.draft = undefined;
												},
												children: "Cancel",
											})}
										</div>
									</div>`
							: ""
					}
				</div>
			</div>
		`;
	}
}
