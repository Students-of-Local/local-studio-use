/** Settings and its sections, loaded the first time Settings opens: the panel's own start carries none of them. */

import { BookOpen, Bot, ChartNoAxesColumn, Globe, Info, Mic, Palette, PanelsTopLeft, Plug, Shield } from "lucide";
import { AboutTab } from "./AboutTab.js";
import { ApiKeysTab } from "./ApiKeysTab.js";
import { AppearanceTab } from "./AppearanceTab.js";
import { BridgeTab } from "./BridgeTab.js";
import { CombinedTab } from "./CombinedTab.js";
import { ConnectTab } from "./ConnectTab.js";
import { CostsTab } from "./CostsTab.js";
import { DictationTab } from "./DictationTab.js";
import { PrivacyTab } from "./PrivacyTab.js";
import { SettingsPage } from "./SettingsPage.js";
import { SiteEditsTab, sitesSummary } from "./SiteEditsTab.js";
import { SkillsTab } from "./SkillsTab.js";
import { UpdatesTab } from "./UpdatesTab.js";

export interface SettingsHooks {
	/** The rows' states that the panel knows. */
	connected: () => Promise<string>;
	agents: () => Promise<string>;
	onChooseModel: () => void;
	/** Settings closes and the composer holds this text. */
	compose: (text: string) => void;
}

/**
 * A list of sections in three groups. Settles when it closes; an open Settings page is reused, not opened twice, and
 * `show` opens it on one section.
 */
export function openSettings(hooks: SettingsHooks, show?: { tab: string; anchor?: string }): Promise<void> {
	const open = document.querySelector<SettingsPage>("local-studio-settings");
	if (open) {
		if (show) open.showTab(show.tab, show.anchor);
		return open.closed;
	}
	const providers = new ApiKeysTab();
	const skills = new SkillsTab();
	const sites = new SiteEditsTab();
	const page = SettingsPage.open(
		[
			[
				{ name: "Providers", icon: Plug, tab: providers, state: hooks.connected },
				{ name: "Agents", icon: Bot, tab: new BridgeTab(), state: hooks.agents },
				{ name: "Connections", icon: Globe, tab: new ConnectTab() },
			],
			[
				{ name: "Skills", icon: BookOpen, tab: skills },
				{ name: "Sites", icon: PanelsTopLeft, tab: sites, state: sitesSummary },
				{ name: "Dictation", icon: Mic, tab: new DictationTab() },
			],
			[
				{ name: "Privacy", icon: Shield, tab: new PrivacyTab() },
				{ name: "Appearance", icon: Palette, tab: new AppearanceTab() },
				{ name: "Costs", icon: ChartNoAxesColumn, tab: new CostsTab() },
				{
					name: "About",
					icon: Info,
					tab: new CombinedTab("About", [{ tab: new AboutTab() }, { tab: new UpdatesTab() }]),
					state: () => chrome.runtime.getManifest().version,
				},
			],
		],
		show,
	);
	providers.onChooseModel = () => {
		page.close();
		hooks.onChooseModel();
	};
	skills.onUse = (name) => {
		page.close();
		hooks.compose(`/${name} `);
	};
	sites.onAsk = (text) => {
		page.close();
		hooks.compose(text);
	};
	return page.closed;
}
