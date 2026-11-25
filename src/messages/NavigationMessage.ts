import type { MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { SkillPill } from "../components/SkillPill.js";
import { getLocalStudioStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";

// ============================================================================
// NAVIGATION MESSAGE TYPE
// ============================================================================

export interface NavigationMessage {
	role: "navigation";
	url: string;
	title: string;
	favicon?: string;
	tabId?: number;
	skillsOutput: string; // Frozen formatted skills text (shown to LLM)
}

// Extend CustomAgentMessages interface via declaration merging
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		navigation: NavigationMessage;
	}
}

// ============================================================================
// NAVIGATION MESSAGE ELEMENT
// ============================================================================

@customElement("navigation-message")
export class NavigationMessageElement extends LitElement {
	@property() url!: string;
	@property() title!: string;
	@property() favicon?: string;
	@state() private skills: Skill[] = [];

	protected createRenderRoot() {
		return this; // light DOM
	}

	override async connectedCallback() {
		super.connectedCallback();
		// Load skills for this URL
		const skillsRepo = getLocalStudioStorage().skills;
		this.skills = await skillsRepo.getSkillsForUrl(this.url);
	}

	override render(): TemplateResult {
		return html`
			<div class="mx-4 my-2 space-y-2">
				<button
					class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
					@click=${() => {
						chrome.tabs.create({ url: this.url });
					}}
					title="Click to open: ${this.url}"
				>
					${
						// The page's own icon or none: no favicon service ever sees the host.
						this.favicon
							? html`<img
								src="${this.favicon}"
								alt=""
								class="w-4 h-4 flex-shrink-0"
								@error=${(e: Event) => {
									(e.target as HTMLImageElement).style.display = "none";
								}}
							/>`
							: nothing
					}
					<span class="truncate font-medium">${this.title}</span>
				</button>
				${
					this.skills.length > 0
						? html`
						<div class="flex flex-wrap gap-2">
							${this.skills.map((skill) => SkillPill(skill, true))}
						</div>
					`
						: ""
				}
			</div>
		`;
	}
}

// ============================================================================
// RENDERER
// ============================================================================

const navigationRenderer: MessageRenderer<NavigationMessage> = {
	render: (nav) => {
		return html`<navigation-message .url=${nav.url} .title=${nav.title} .favicon=${nav.favicon}></navigation-message>`;
	},
};

// ============================================================================
// REGISTER
// ============================================================================

export function registerNavigationRenderer() {
	registerMessageRenderer("navigation", navigationRenderer);
}

// ============================================================================
// HELPER
// ============================================================================

export async function createNavigationMessage(
	url: string,
	title: string,
	favicon?: string,
	tabId?: number,
): Promise<NavigationMessage> {
	// Get skills for this URL and format them
	const skillsRepo = getLocalStudioStorage().skills;
	const matchingSkills = await skillsRepo.getSkillsForUrl(url);
	const { formattedText: skillsOutput } = formatSkills(matchingSkills);

	return {
		role: "navigation",
		url,
		title,
		favicon,
		tabId,
		skillsOutput,
	};
}
