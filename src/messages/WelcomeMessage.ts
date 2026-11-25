import { icon } from "@mariozechner/mini-lit";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentInterface, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { localStudioMark } from "../components/LocalStudioMark.js";
import "../subscriptions/ConnectList.js";
import type { StarterPrompt } from "../tutorials.js";
import "../utils/i18n-extension.js";

export type TutorialPrompt = StarterPrompt;

/** Whether nothing can answer a chat yet, and what the panel does from there; the empty chat follows it in place. */
interface WelcomeSetup {
	needsModel: boolean;
	onApiKey?: () => void;
	onChangeSite?: () => void;
}
let setup: WelcomeSetup = { needsModel: false };
const shown = new Set<LitElement>();

export function setWelcomeSetup(next: WelcomeSetup): void {
	setup = next;
	for (const element of shown) element.requestUpdate();
}

export interface WelcomeMessage {
	role: "welcome";
	tutorials: TutorialPrompt[];
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		welcome: WelcomeMessage;
	}
}

/** Put text in the chat input with the caret at the end; the input event opens the menu a "/" or "@" asks for. */
export function composeText(agentInterface: AgentInterface | undefined, text: string): void {
	const textarea = agentInterface?.querySelector<HTMLTextAreaElement>("message-editor textarea");
	if (!textarea) return;
	textarea.value = text;
	textarea.focus();
	textarea.setSelectionRange(text.length, text.length);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

@customElement("welcome-message")
export class WelcomeMessageElement extends LitElement {
	@property({ type: Array }) tutorials!: TutorialPrompt[];
	@property({ attribute: false }) agent!: Agent;
	@property({ attribute: false }) agentInterface!: AgentInterface;
	@property({ attribute: false }) message!: WelcomeMessage;

	protected createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		shown.add(this);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		shown.delete(this);
	}

	private async selectTutorial(starter: TutorialPrompt) {
		if (starter.mode === "compose") {
			composeText(this.agentInterface, starter.prompt);
			return;
		}
		if (starter.mode === "sites") {
			setup.onChangeSite?.();
			return;
		}
		// Remove this welcome message
		const messages = this.agent.state.messages.filter((m) => m !== this.message);
		this.agent.replaceMessages(messages);

		// Send the prompt
		await this.agentInterface.sendMessage(starter.prompt);
	}

	private renderConnect(): TemplateResult {
		return html`
			<div class="welcome-container flex flex-col items-center justify-center">
				<div class="flex w-full max-w-md flex-col gap-4 px-4" data-welcome-connect>
					<div class="flex flex-col items-center text-center">
						${localStudioMark(48, "mb-3")}
						<h1 class="text-lg font-semibold tracking-tight">${i18n("Connect a model to chat here")}</h1>
					</div>
					<local-studio-connect-list .onApiKey=${setup.onApiKey}></local-studio-connect-list>
					${agentSetupPromptButton("Claude Code, Codex and other agents can drive this browser without one.")}
				</div>
			</div>
		`;
	}

	override render(): TemplateResult {
		if (setup.needsModel) return this.renderConnect();
		return html`
			<div class="welcome-container flex flex-col items-center justify-center">
				<div class="flex flex-col items-center text-center mb-6 px-6">
					${localStudioMark(64, "mb-4")}
					<h1 class="text-2xl font-semibold tracking-tight mb-1.5">Local Studio</h1>
					<p class="text-sm text-muted-foreground max-w-xs">${i18n("You steer. Local Studio works the tabs.")}</p>
				</div>

				<!-- Starter chips: two columns while a pill fits in 10rem, one at a large theme size or a narrow panel (#13) -->
				<div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2 w-full max-w-md px-4">
					${this.tutorials.map(
						(starter) => html`
							<button
								type="button"
								class="tutorial-pill flex items-start gap-2.5 px-3 py-2.5 text-left rounded-xl cursor-pointer min-h-14"
								data-starter=${starter.mode}
								@click=${() => this.selectTutorial(starter)}
							>
								${starter.icon ? html`<span class="tk-starter-icon inline-flex shrink-0 mt-0.5">${icon(starter.icon, "sm")}</span>` : ""}
								<span class="min-w-0">
									<span class="block text-sm font-medium text-foreground leading-snug">${starter.label}</span>
									${starter.hint ? html`<span class="block text-xs text-muted-foreground leading-snug mt-0.5">${starter.hint}</span>` : ""}
								</span>
							</button>
						`,
					)}
				</div>
			</div>
		`;
	}
}

export function createWelcomeRenderer(agent: Agent, agentInterface: AgentInterface): MessageRenderer<WelcomeMessage> {
	return {
		render: (message) => {
			// Only show if no conversation started yet
			const hasConversation = agent.state.messages.some((m) => m.role === "user" || m.role === "assistant");

			if (hasConversation) return html``;

			return html`<welcome-message
				.tutorials=${message.tutorials}
				.agent=${agent}
				.agentInterface=${agentInterface}
				.message=${message}
			></welcome-message>`;
		},
	};
}

export function registerWelcomeRenderer(agent: Agent, agentInterface: AgentInterface) {
	registerMessageRenderer("welcome", createWelcomeRenderer(agent, agentInterface));
}

export function createWelcomeMessage(tutorials: TutorialPrompt[]): WelcomeMessage {
	return { role: "welcome", tutorials };
}
