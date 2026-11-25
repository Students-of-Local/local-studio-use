import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import "../dictation/DictationSettings.js";

/** Settings > Dictation: speech to text on this device. */
@customElement("local-studio-dictation-tab")
export class DictationTab extends SettingsTab {
	getTabName(): string {
		return "Dictation";
	}

	render(): TemplateResult {
		return html`<local-studio-dictation-settings></local-studio-dictation-settings>`;
	}
}
