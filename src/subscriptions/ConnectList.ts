import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { hostCommand } from "../bridge/host-command.js";
import { watchHostConnected } from "../bridge/host-state.js";
import { COMMAND_BOX_CLASS } from "../components/command-box.js";
import { Toast } from "../components/Toast.js";
import { localStudioModels, localStudioReachable, refreshLocalStudioModels } from "../eukhe/stream.js";
import { APP_DOWNLOAD_URL } from "../release-source.js";
import { request, SubscriptionRequestError, type SubscriptionStatus, subscriptionStatus } from "./client.js";
import { COPILOT, cliMcpSetup, SIWC } from "./constants.js";
import { refreshSubscriptionModels } from "./stream.js";

/** chrome.storage.local flag: the "You're using your ChatGPT plan" note was shown once (no token in it). */
export const CHATGPT_WELCOME_KEY = "local-studio.chatgptPlanWelcomeShown";
/** Fired (bubbling) once the list has drawn the helper's first answer, or the reason there is none. */
export const SUBSCRIPTIONS_LOADED = "subscriptions-loaded";
/** Fired (bubbling) after a sign-in, a sign-out or a look for the app that found something new: what can answer a chat may have changed. */
export const CONNECT_CHANGED = "connect-changed";

/** Systems the Local Studio app is built for; its row stays away elsewhere. */
const APP_SYSTEMS: ReadonlySet<string> = new Set(["mac", "win", "linux"]);

/**
 * Where the side panel's answers can come from, one row each: the Local Studio app, the two plans with a sign-in other
 * apps may use, and the plans whose terms don't allow one (those run their own CLI with Local Studio's MCP server;
 * docs/auth-policy.md). The empty chat and Settings > Providers draw the same list.
 */
@customElement("local-studio-connect-list")
export class ConnectList extends LitElement {
	/** Adds an "API key" row that calls this. */
	@property({ attribute: false }) onApiKey?: () => void;
	@state() private status?: SubscriptionStatus;
	@state() private error?: string;
	/** The native host isn't connected: the usual reason, not a failure. */
	@state() private noHost = false;
	@state() private busy?: "chatgpt" | "copilot";
	@state() private deviceCode?: { userCode: string; verificationUri: string };
	@state() private welcome = false;
	/** What to say under a row: a sign-in's outcome, or what is missing. */
	@state() private notice?: { row: "chatgpt" | "copilot"; text: string };
	/** The row whose button was pressed with no helper to run it. */
	@state() private needsHelper?: "chatgpt" | "copilot";
	@state() private showCli = false;
	/** Models the app answers with; undefined until it was asked. */
	@state() private studioModels?: number;
	@state() private checking = false;
	/** Whether the app runs on this system; undefined until known. */
	@state() private appRuns?: boolean;
	@state() private copied?: string;
	private copiedTimer?: ReturnType<typeof setTimeout>;
	/** The "Couldn't copy" toast, taken down as soon as a copy works. */
	private copyFailed?: Element;
	private stopWatching?: () => void;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		chrome.runtime
			.getPlatformInfo()
			.then((info) => {
				this.appRuns = APP_SYSTEMS.has(info.os);
			})
			.catch(() => {
				this.appRuns = false;
			});
		// Called with the current state at once, then on every change: the rows follow the helper with no reload.
		this.stopWatching = watchHostConnected(() => {
			void this.load();
			void this.checkApp();
		});
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.stopWatching?.();
	}

	private changed(): void {
		this.dispatchEvent(new Event(CONNECT_CHANGED, { bubbles: true, composed: true }));
	}

	private async checkApp(): Promise<void> {
		const before = localStudioModels().length;
		this.checking = true;
		this.studioModels = (await refreshLocalStudioModels().catch(() => [])).length;
		this.checking = false;
		if (this.studioModels !== before) this.changed();
	}

	private async load(): Promise<void> {
		try {
			this.status = await subscriptionStatus(true);
			this.error = undefined;
			this.noHost = false;
			this.needsHelper = undefined;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.noHost = err instanceof SubscriptionRequestError && err.code === "no_host";
		}
		// Drawn with the answer: Settings > Providers shows once this is in, so its rows don't move after.
		await this.updateComplete;
		this.dispatchEvent(new Event(SUBSCRIPTIONS_LOADED, { bubbles: true }));
	}

	private async signInChatGpt(): Promise<void> {
		this.busy = "chatgpt";
		this.notice = undefined;
		try {
			const result = await request<{ planUsage: boolean; firstPlanUsage?: boolean }>(
				"chatgpt.signin",
				(progress) => {
					// The sign-in page opens in a normal tab of this browser; the host's loopback listener gets the callback.
					if (
						typeof progress.authorizeUrl === "string" &&
						progress.authorizeUrl.startsWith(`${SIWC.authorizeUrl}?`)
					)
						void chrome.tabs.create({ url: progress.authorizeUrl, active: true });
				},
			);
			if (!result.planUsage)
				this.note(
					"chatgpt",
					"Signed in, but ChatGPT plan usage wasn't allowed. Choose Continue with ChatGPT again to allow it, or add an OpenAI API key.",
				);
			if (result.firstPlanUsage) {
				const seen = await chrome.storage.local.get(CHATGPT_WELCOME_KEY);
				if (!seen[CHATGPT_WELCOME_KEY]) this.welcome = true;
			}
			await refreshSubscriptionModels();
		} catch (err) {
			this.note("chatgpt", err instanceof Error ? err.message : String(err));
		}
		this.busy = undefined;
		await this.load();
		this.changed();
	}

	private async signInCopilot(): Promise<void> {
		this.busy = "copilot";
		this.notice = undefined;
		try {
			await request("copilot.signin", (progress) => {
				if (typeof progress.userCode === "string" && typeof progress.verificationUri === "string") {
					this.deviceCode = { userCode: progress.userCode, verificationUri: progress.verificationUri };
					if (progress.verificationUri.startsWith("https://github.com/"))
						void chrome.tabs.create({ url: progress.verificationUri, active: true });
				}
			});
			await refreshSubscriptionModels();
		} catch (err) {
			this.note("copilot", err instanceof Error ? err.message : String(err));
		}
		this.deviceCode = undefined;
		this.busy = undefined;
		await this.load();
		this.changed();
	}

	private async cancel(which: "chatgpt" | "copilot"): Promise<void> {
		await request(`${which}.cancel`).catch(() => undefined);
	}

	private async signOut(which: "chatgpt" | "copilot"): Promise<void> {
		this.notice = undefined;
		try {
			const result = await request<{ revoked: boolean; revokeUrl?: string }>(`${which}.signout`);
			if (which === "chatgpt" && !result.revoked)
				this.note(
					which,
					"Signed out here, but OpenAI didn't confirm the session was revoked. You can disconnect it in ChatGPT Settings, where an older sign-in may have another name.",
				);
			if (which === "copilot")
				this.note(
					which,
					`Signed out: the token is deleted from this computer. To remove its access on GitHub too, revoke it at ${COPILOT.revokeUrl}.`,
				);
			await refreshSubscriptionModels();
		} catch (err) {
			this.note(which, err instanceof Error ? err.message : String(err));
		}
		await this.load();
		this.changed();
	}

	private note(row: "chatgpt" | "copilot", text: string): void {
		this.notice = { row, text };
	}

	/** A sign-in runs in the helper. Without one the button says what is missing instead of greying out. */
	private press(row: "chatgpt" | "copilot"): void {
		if (!this.status) {
			this.needsHelper = row;
			return;
		}
		void (row === "chatgpt" ? this.signInChatGpt() : this.signInCopilot());
	}

	private async dismissWelcome(): Promise<void> {
		this.welcome = false;
		await chrome.storage.local.set({ [CHATGPT_WELCOME_KEY]: true });
	}

	private copy(text: string): void {
		navigator.clipboard.writeText(text).then(
			() => {
				this.copyFailed?.remove();
				this.copyFailed = undefined;
				clearTimeout(this.copiedTimer);
				this.copied = text;
				this.copiedTimer = setTimeout(() => {
					this.copied = undefined;
				}, 1500);
			},
			// A toast, not the section's notice: it can't overwrite a sign-out message or outlive a later copy.
			() => {
				this.copyFailed = Toast.error("Couldn't copy. Click the side panel first, then try again.");
			},
		);
	}

	/** One shell command the user pastes into a terminal: labeled, monospace, with its own copy button. */
	private command(label: string, text: string): TemplateResult {
		return html`
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
						aria-label=${`Copy the ${label} command`}
						@click=${() => this.copy(text)}
					>
						<span aria-hidden="true">${this.copied === text ? "Copied" : "Copy"}</span>
					</button>
					<span class="sr-only" role="status">${this.copied === text ? `Copied the ${label} command` : ""}</span>
				</div>
				<code class=${COMMAND_BOX_CLASS}>${text}</code>
			</div>
		`;
	}

	/** A row: its name, one line of state, and one control. What follows shows under it. */
	private row(
		id: string,
		name: string,
		line: string | TemplateResult,
		control: TemplateResult | typeof nothing,
		under: TemplateResult | typeof nothing = nothing,
	): TemplateResult {
		return html`
			<div data-subscription=${id}>
				<div class="tk-row">
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-foreground">${name}</span>
						${line ? html`<span class="block text-xs text-muted-foreground break-words">${line}</span>` : nothing}
					</span>
					${control}
				</div>
				${under === nothing ? nothing : html`<div class="flex flex-col gap-2 px-3 pb-3 text-xs text-muted-foreground">${under}</div>`}
			</div>
		`;
	}

	private button(
		children: string,
		onClick: () => void,
		opts: { label?: string; disabled?: boolean } = {},
	): TemplateResult {
		return html`<button
			type="button"
			class="tk-row-button"
			aria-label=${opts.label ?? children}
			?disabled=${opts.disabled}
			@click=${onClick}
		>
			${children}
		</button>`;
	}

	private renderApp(): TemplateResult | typeof nothing {
		if (!this.appRuns) return nothing;
		const models = this.studioModels;
		if (models)
			return this.row("studio", "Local Studio app", `${models} ${models === 1 ? "model" : "models"} ready`, nothing);
		if (this.noHost)
			return this.row(
				"studio",
				"Local Studio app",
				"Runs models on this computer",
				html`<a class="tk-row-button" href=${APP_DOWNLOAD_URL} target="_blank" rel="noopener" data-get-app>Get the app</a>`,
			);
		return this.row(
			"studio",
			"Local Studio app",
			this.checking || models === undefined
				? "Checking"
				: localStudioReachable()
					? "Open, with no model ready yet"
					: "Open the app, then check",
			this.button("Check", () => void this.checkApp(), {
				label: "Check for the Local Studio app",
				disabled: this.checking,
			}),
		);
	}

	private renderSignIn(which: "chatgpt" | "copilot"): TemplateResult {
		const s = this.status;
		const chatgpt = which === "chatgpt";
		const signedIn = Boolean(chatgpt ? s?.chatgpt.signedIn : s?.copilot.signedIn);
		const who = chatgpt ? s?.chatgpt.email : s?.copilot.login;
		const control = signedIn
			? this.button("Sign out", () => void this.signOut(which))
			: this.busy === which
				? this.button("Cancel", () => void this.cancel(which))
				: this.button(chatgpt ? "Continue with ChatGPT" : "Sign in", () => this.press(which), {
						label: chatgpt ? undefined : "Sign in with GitHub Copilot",
						disabled: Boolean(this.busy),
					});
		const under: TemplateResult[] = [];
		if (chatgpt && this.welcome)
			under.push(html`<div class="flex flex-col gap-2" role="dialog" aria-label="You're using your ChatGPT plan">
				<span class="text-sm font-medium text-foreground">You're using your ChatGPT plan</span>
				<span>Eligible usage in this app uses your ChatGPT plan. Manage usage in your ${link(SIWC.usageUrl, "ChatGPT settings")}.</span>
				<div>${Button({ size: "sm", variant: "default", children: "Got it", onClick: () => void this.dismissWelcome() })}</div>
			</div>`);
		if (chatgpt && s?.chatgpt.signedIn && !s.chatgpt.planUsage)
			under.push(
				html`<p>ChatGPT plan usage isn't enabled for this sign-in. Sign out and choose Continue with ChatGPT to allow it, or use an OpenAI API key.</p>`,
			);
		if (!chatgpt && this.deviceCode)
			under.push(html`<p>Enter <code class="font-mono font-semibold text-foreground" data-device-code>${this.deviceCode.userCode}</code> at ${link(this.deviceCode.verificationUri, this.deviceCode.verificationUri)}
				${Button({ size: "sm", variant: "ghost", children: "Copy code", onClick: () => this.copy(this.deviceCode?.userCode ?? "") })}</p>`);
		if (!chatgpt && s?.copilot.signedIn && !s.copilot.sdkInstalled)
			under.push(
				html`<p>Copilot needs GitHub's Copilot SDK on this computer (about 160 MB).</p>
					${this.command("Install the Copilot SDK", `${hostCommand()} copilot-sdk install`)}`,
			);
		if (this.needsHelper === which)
			under.push(html`<div class="flex flex-col gap-2" role="status" data-subscription-setup>
				<p>
					${
						this.noHost || !this.error
							? "The sign-in runs in Local Studio's helper, which isn't connected. The Local Studio app brings it. If you have the helper, run this in a terminal:"
							: `This sign-in isn't available: ${this.error.replace(/\.?$/, ".")} Running this in a terminal usually fixes it:`
					}
				</p>
				${this.command("Set up the Local Studio helper", `${hostCommand()} setup`)}
				${this.noHost ? html`<p data-helper-install>${link(APP_DOWNLOAD_URL, "Get the Local Studio app")}</p>` : nothing}
			</div>`);
		if (this.notice?.row === which) under.push(html`<p role="status">${this.notice.text}</p>`);
		return this.row(
			which,
			chatgpt ? "ChatGPT plan" : "GitHub Copilot plan",
			signedIn
				? html`Signed in${who ? html` as ${who}` : nothing}${chatgpt ? html`. ${link(SIWC.usageUrl, "Manage usage")}` : nothing}`
				: "",
			control,
			under.length ? html`${under}` : nothing,
		);
	}

	private renderCli(): TemplateResult {
		return this.row(
			"cli",
			"Claude or Gemini plan",
			"",
			html`<button
				type="button"
				class="tk-row-button"
				aria-label="How to use a Claude or Gemini plan"
				aria-expanded=${this.showCli ? "true" : "false"}
				@click=${() => {
					this.showCli = !this.showCli;
				}}
			>
				How
			</button>`,
			this.showCli
				? html`<p>
							Run Claude Code or Gemini CLI with Local Studio's MCP server, and it drives this browser on your plan.
							Anthropic's and Google's terms don't allow other apps to sign in with those plans, so this extension doesn't.
						</p>
						${this.command("Claude Code", cliMcpSetup("claude", hostCommand()))}
						${this.command("Gemini CLI", cliMcpSetup("gemini", hostCommand()))}`
				: nothing,
		);
	}

	override render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-2">
				<div class="tk-list" data-connect-list>
					${this.renderApp()} ${this.renderSignIn("chatgpt")} ${this.renderSignIn("copilot")} ${this.renderCli()}
					${
						this.onApiKey
							? this.row(
									"key",
									"API key",
									"Anthropic, OpenAI, OpenRouter, more",
									this.button("Add", () => this.onApiKey?.(), { label: "Add an API key" }),
								)
							: nothing
					}
				</div>
				<details class="tk-more px-1 text-xs text-muted-foreground">
					<summary>About these sign-ins</summary>
					<p class="mt-1.5">
						Your tokens stay on this computer, in files only you can read. The browser never holds them. ChatGPT uses your
						own plan, allowed by ${link(SIWC.termsUrl, "OpenAI's terms for open-source apps")}. Copilot uses your own plan
						through GitHub's Copilot SDK, allowed by ${link(COPILOT.termsUrl, "GitHub's Copilot SDK docs")}. Sign out
						anytime.
					</p>
				</details>
			</div>
		`;
	}
}

const link = (href: string, text: string): TemplateResult =>
	html`<a class="underline" href=${href} target="_blank" rel="noopener">${text}</a>`;
