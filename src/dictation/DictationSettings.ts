/** Settings > Privacy > Dictation: which speech model runs on this device, and its download. */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { group, rowText } from "../components/settings-form.js";
import { Toast } from "../components/Toast.js";
import {
	cachedModels,
	DEFAULT_SETTING,
	type DictationSetting,
	readSetting,
	removeCachedModels,
	writeSetting,
} from "./settings.js";
import { chooseModel, MODELS, type ModelKey, profileDevice } from "./tiers.js";

const LANGUAGES: Array<[string, string]> = [
	["auto", "Detect it"],
	["en", "English"],
	["es", "Spanish"],
	["fr", "French"],
	["de", "German"],
	["it", "Italian"],
	["pt", "Portuguese"],
	["nl", "Dutch"],
	["pl", "Polish"],
	["ru", "Russian"],
	["uk", "Ukrainian"],
	["tr", "Turkish"],
	["ar", "Arabic"],
	["hi", "Hindi"],
	["zh", "Chinese"],
	["ja", "Japanese"],
	["ko", "Korean"],
];

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

@customElement("local-studio-dictation-settings")
export class DictationSettings extends LitElement {
	@state() private setting: DictationSetting = DEFAULT_SETTING;
	@state() private auto?: { key: ModelKey; why: string };
	@state() private gpu = false;
	@state() private stored = { files: 0, bytes: 0 };
	private device?: Awaited<ReturnType<typeof profileDevice>>;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override async connectedCallback(): Promise<void> {
		super.connectedCallback();
		this.setting = await readSetting();
		const device = await profileDevice();
		this.gpu = device.webgpu;
		this.device = device;
		this.auto = chooseModel(device, this.setting.language);
		this.stored = await cachedModels();
	}

	private async save(next: Partial<DictationSetting>): Promise<void> {
		this.setting = { ...this.setting, ...next };
		if (this.device) this.auto = chooseModel(this.device, this.setting.language);
		await writeSetting(this.setting);
	}

	private async removeModels(): Promise<void> {
		await removeCachedModels();
		this.stored = await cachedModels();
		Toast.success("Downloaded speech models removed. The next dictation downloads one again.");
	}

	override render(): TemplateResult {
		const auto = this.auto ? MODELS[this.auto.key] : undefined;
		const size = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} GB` : `${m} MB`);
		return html`
			<div class="flex flex-col gap-5" data-testid="dictation-settings">
				<p class="tk-group-note">The microphone button turns speech into text on this computer. The audio never leaves the browser; the model is downloaded once from Hugging Face.</p>
				${group(
					"",
					html`<label class="tk-row flex-wrap">
							${rowText("Model", auto ? `Best for this computer: ${auto.label}, a ${size(auto.downloadMB)} download` : "Checking this device")}
							<select
								class="tk-select basis-full"
								.value=${this.setting.model}
								@change=${(e: Event) => void this.save({ model: (e.target as HTMLSelectElement).value as DictationSetting["model"] })}
							>
								<option value="auto">Automatic</option>
								${(Object.keys(MODELS) as ModelKey[]).map(
									(key) =>
										html`<option value=${key} ?disabled=${MODELS[key].device === "webgpu" && !this.gpu}>
											${MODELS[key].label}, ${MODELS[key].device === "webgpu" ? "GPU" : "processor"}, ${size(MODELS[key].downloadMB)}
										</option>`,
								)}
							</select>
						</label>
						<label class="tk-row">
							${rowText("Language")}
							<select class="tk-select" .value=${this.setting.language} @change=${(e: Event) => void this.save({ language: (e.target as HTMLSelectElement).value })}>
								${LANGUAGES.map(([code, name]) => html`<option value=${code}>${name}</option>`)}
							</select>
						</label>
						<div class="tk-row">
							${rowText("Downloaded", this.stored.files ? (this.stored.bytes ? mb(this.stored.bytes) : `${this.stored.files} files`) : "Nothing yet")}
							${
								this.stored.files
									? html`<button type="button" class="tk-row-quiet" @click=${() => void this.removeModels()}>Remove</button>`
									: nothing
							}
						</div>`,
					html`${this.renderEnglishOnly(auto?.label)}`,
				)}
			</div>
		`;
	}

	/** An English-only model was picked for another language. */
	private renderEnglishOnly(instead: string | undefined): TemplateResult | typeof nothing {
		const { model, language } = this.setting;
		if (model === "auto" || MODELS[model].multilingual || !instead) return nothing;
		if (language === "auto" ? /^en\b/i.test(navigator.language) : language === "en") return nothing;
		const name = LANGUAGES.find(([code]) => code === language)?.[1] ?? language;
		return html`<p>${MODELS[model].label} is English-only, so ${name} dictation uses ${instead}.</p>`;
	}
}
