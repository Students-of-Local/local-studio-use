import { icon } from "@mariozechner/mini-lit";
import { type CustomProvider, SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { Plus } from "lucide";
import { group, rowText } from "../components/settings-form.js";
import { Toast } from "../components/Toast.js";
import { getLocalStudioStorage } from "../storage/app-storage.js";
import { CustomProviderEditDialog } from "./CustomProviderEditDialog.js";

/**
 * Settings tab for managing custom (BYO base URL + key) providers.
 * Models defined here show up in the model selector alongside the built-in providers.
 */
export class CustomProvidersTab extends SettingsTab {
	private providers: CustomProvider[] = [];

	getTabName(): string {
		return "Custom Providers";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadProviders();
	}

	private async loadProviders() {
		try {
			this.providers = await getLocalStudioStorage().customProviders.getAll();
			this.requestUpdate();
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		}
	}

	private add() {
		CustomProviderEditDialog.open(undefined, () => this.loadProviders());
	}

	private edit(provider: CustomProvider) {
		CustomProviderEditDialog.open(provider, () => this.loadProviders());
	}

	private async removeProvider(provider: CustomProvider) {
		if (!confirm(`Delete custom provider "${provider.name}"?`)) return;
		try {
			const storage = getLocalStudioStorage();
			await storage.customProviders.delete(provider.id);
			// Remove the mirrored key entry created on save.
			await storage.providerKeys.delete(provider.name);
			await this.loadProviders();
			Toast.success("Provider deleted");
		} catch (error) {
			console.error("Failed to delete custom provider:", error);
			Toast.error("Failed to delete provider");
		}
	}

	private renderProvider(provider: CustomProvider): TemplateResult {
		const modelCount = provider.models?.length ?? 0;
		return html`
			<div class="tk-row">
				${rowText(provider.name, [provider.baseUrl || provider.type, `${modelCount} ${modelCount === 1 ? "model" : "models"}`].join(" · "))}
				<button type="button" class="tk-row-quiet" @click=${() => this.edit(provider)}>Edit</button>
				<button type="button" class="tk-row-quiet" @click=${() => this.removeProvider(provider)}>Delete</button>
			</div>
		`;
	}

	render(): TemplateResult {
		return group(
			"Custom providers",
			html`${this.providers.map((p) => this.renderProvider(p))}
				<button type="button" class="tk-row tk-row-link" @click=${() => this.add()}>
					${rowText("Add an endpoint", "Any OpenAI- or Anthropic-compatible server, by base URL and key")}
					<span class="tk-row-chevron" aria-hidden="true">${icon(Plus, "sm")}</span>
				</button>`,
		);
	}
}

if (!customElements.get("custom-providers-tab")) {
	customElements.define("custom-providers-tab", CustomProvidersTab);
}
