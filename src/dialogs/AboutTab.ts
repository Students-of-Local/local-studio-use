import { icon } from "@mariozechner/mini-lit";
import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { ArrowUpRight } from "lucide";
import { localStudioMark } from "../components/LocalStudioMark.js";
import { group, rowText } from "../components/settings-form.js";
import { SOURCE_URL } from "../release-source.js";
import "../utils/i18n-extension.js";

const linkRow = (href: string, name: string, help: string) =>
	html`<a class="tk-row tk-row-link" href=${href} target="_blank" rel="noopener">
		${rowText(name, help.charAt(0).toUpperCase() + help.slice(1))}<span class="tk-row-chevron" aria-hidden="true">${icon(ArrowUpRight, "sm")}</span>
	</a>`;

@customElement("about-tab")
export class AboutTab extends SettingsTab {
	getTabName(): string {
		return i18n("About");
	}

	render(): TemplateResult {
		const version = chrome.runtime.getManifest().version;

		return html`
			<div class="flex flex-col gap-5">
				<div class="flex items-center gap-3">
					${localStudioMark(44)}
					<div>
						<p class="text-base font-semibold text-foreground">Local Studio</p>
						<p class="text-xs text-muted-foreground">${i18n("Version:")} ${version}</p>
					</div>
				</div>
				<p class="text-sm text-foreground">${i18n("An AI agent in your side panel, and a browser your coding agents can drive.")}</p>
				${group(
					i18n("Built on the work of"),
					html`${linkRow(
						"https://github.com/0xSero/sitegeist",
						"0xSero (0xSero/sitegeist)",
						i18n(
							"the agent bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the foreground guard.",
						),
					)}${linkRow(
						"https://github.com/badlogic/sitegeist",
						"Mario Zechner (badlogic/sitegeist)",
						i18n("the original Sitegeist extension and the pi agent libraries it runs on."),
					)}`,
				)}
				${group("", linkRow(SOURCE_URL, "Source code", "AGPL-3.0, at github.com/baney75/local-studio"))}
			</div>
		`;
	}
}
