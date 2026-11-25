/** Choosing a model: a page with a search, the thinking level and one list per provider, newest first. */

import { icon } from "@mariozechner/mini-lit";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { discoverModels, getAppStorage } from "@mariozechner/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Check, ChevronDown } from "lucide";
import { PageBase } from "../components/PageBase.js";
import { modelDisplayName, providerDisplayName } from "../models/display.js";
import { FREE_MODEL_NAME } from "../models/free-mode.js";
import { freeModeModel } from "../models/free-runtime.js";
import { type AnyModel, findModels, type Group, modelFacts, modelGroups, SHOWN } from "../models/pick.js";
import "../utils/i18n-extension.js";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
/** A server that answers with its own list; anything else has its models saved. */
const LISTS_ITSELF = ["ollama", "llama.cpp", "vllm", "lmstudio"] as const;

export interface Thinking {
	level: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
}

@customElement("local-studio-model-page")
export class ModelPage extends PageBase {
	@state() private current: AnyModel | null = null;
	@state() private query = "";
	@state() private thinking?: Thinking;
	@state() private providers: ReadonlySet<string> = new Set();
	@state() private custom: AnyModel[] = [];
	/** Providers whose whole list shows. */
	@state() private open_ = new Set<string>();
	private choose: (model: AnyModel) => void = () => undefined;

	protected override fillsHeight = true;

	static open(
		current: AnyModel | null,
		choose: (model: AnyModel) => void,
		providers: string[],
		thinking: Thinking,
	): ModelPage {
		const page = new ModelPage();
		Object.assign(page, { current, choose, thinking, providers: new Set(providers) });
		page.open();
		void page.updateComplete.then(() => page.querySelector<HTMLInputElement>("input[type=search]")?.focus());
		void page.loadCustom();
		return page;
	}

	/** Lists that arrived after the page opened: more providers, or a provider's fresh models. */
	refreshed(providers: string[]): void {
		this.providers = new Set(providers);
	}

	private async loadCustom(): Promise<void> {
		const found: AnyModel[] = [];
		for (const provider of await getAppStorage()
			.customProviders.getAll()
			.catch(() => [])) {
			const type = LISTS_ITSELF.find((t) => t === provider.type);
			if (!type) found.push(...(provider.models ?? []));
			else
				found.push(
					...(await discoverModels(type, provider.baseUrl, provider.apiKey).catch(() => [])).map((model) => ({
						...model,
						provider: provider.name,
					})),
				);
		}
		this.custom = found;
	}

	private models(): AnyModel[] {
		const known = getProviders().flatMap((provider) => getModels(provider) as AnyModel[]);
		return [...known, ...this.custom].filter((model) => this.providers.has(model.provider));
	}

	private pick(model: AnyModel): void {
		this.close();
		this.choose(model);
	}

	private move(event: KeyboardEvent, found: AnyModel[] | undefined): void {
		const input = event.target instanceof HTMLInputElement;
		if (event.key === "Enter" && input && !event.isComposing && found?.[0]) {
			event.preventDefault();
			this.pick(found[0]);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const rows = [...this.querySelectorAll<HTMLElement>("[data-model-item]")];
		const at = rows.indexOf(document.activeElement as HTMLElement);
		if (!input && at < 0) return;
		event.preventDefault();
		const to = at + (event.key === "ArrowDown" ? 1 : -1);
		if (to < 0) this.querySelector<HTMLElement>("input[type=search]")?.focus();
		else rows[Math.min(to, rows.length - 1)]?.focus();
	}

	private renderThinking(): TemplateResult | typeof nothing {
		const { thinking } = this;
		if (!thinking || this.current?.reasoning === false) return nothing;
		return html`<div class="flex flex-col gap-1.5">
			<span class="tk-group-name" id="thinking-name">Thinking</span>
			<div class="tk-seg" role="radiogroup" aria-labelledby="thinking-name">
				${THINKING.map(
					(level) => html`<button
						type="button"
						role="radio"
						aria-checked=${thinking.level === level ? "true" : "false"}
						@click=${() => {
							this.thinking = { ...thinking, level };
							thinking.onChange(level);
						}}
					>
						${level[0].toUpperCase()}${level.slice(1)}
					</button>`,
				)}
			</div>
		</div>`;
	}

	private renderModel(model: AnyModel, provider = false): TemplateResult {
		const current = model.id === this.current?.id && model.provider === this.current.provider;
		const facts = modelFacts(model);
		return html`<button
			type="button"
			class="tk-row tk-row-link"
			data-model-item
			aria-current=${current ? "true" : nothing}
			title=${model.id}
			@click=${() => this.pick(model)}
		>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-sm font-medium">${modelDisplayName(model)}</span>
				<span class="block truncate text-xs text-muted-foreground"
					>${provider ? `${providerDisplayName(model.provider)} · ` : ""}${facts}</span
				>
			</span>
			${current ? html`<span class="tk-row-check" aria-label="In use">${icon(Check, "sm")}</span>` : nothing}
		</button>`;
	}

	private renderGroup(group: Group, first: boolean): TemplateResult {
		const all = this.open_.has(group.provider) || group.models.length <= SHOWN + 1;
		const shown = all ? group.models : group.models.slice(0, SHOWN);
		return html`<section class="flex flex-col gap-1.5" aria-label=${group.name}>
			<h3 class="tk-group-name flex justify-between gap-3">
				${group.name}${first ? html`<span class="font-normal">Price per million tokens</span>` : nothing}
			</h3>
			<div class="tk-list">
				${shown.map((model) => this.renderModel(model))}
				${
					all
						? nothing
						: html`<button
							type="button"
							class="tk-row tk-row-link text-sm text-muted-foreground"
							data-show-all=${group.provider}
							@click=${() => {
								this.open_ = new Set([...this.open_, group.provider]);
							}}
						>
							<span class="flex-1">Show all ${group.models.length}</span>
							<span class="tk-row-chevron" aria-hidden="true">${icon(ChevronDown, "sm")}</span>
						</button>`
				}
			</div>
		</section>`;
	}

	private renderFree(): TemplateResult {
		return html`<div class="tk-list">
			<button type="button" class="tk-row tk-row-link" data-model-item @click=${() => this.pick(freeModeModel())}>
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-medium">${FREE_MODEL_NAME}</span>
					<span class="block truncate text-xs text-muted-foreground">OpenRouter. Providers may log prompts.</span>
				</span>
			</button>
		</div>`;
	}

	protected override pageTitle(): string {
		return "Models";
	}

	protected override renderContent(): TemplateResult {
		const models = this.models();
		const found = this.query.trim() ? findModels(models, this.query) : undefined;
		return html`
			<div
				class="tk-page-body min-h-0 flex-1 overflow-y-auto"
				@keydown=${(e: KeyboardEvent) => this.move(e, found)}
			>
				<div class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-4">
					<input
						type="search"
						class="tk-search"
						aria-label="Search models"
						placeholder="Search models"
						.value=${this.query}
						@input=${(e: InputEvent) => {
							this.query = (e.target as HTMLInputElement).value;
						}}
					/>
					${
						found
							? found.length
								? html`<div class="tk-list">${found.slice(0, 60).map((model) => this.renderModel(model, true))}</div>`
								: html`<p class="py-6 text-center text-sm text-muted-foreground">No model matches.</p>`
							: html`${this.renderThinking()} ${this.renderFree()}
								${modelGroups(models, this.current).map((group, i) => this.renderGroup(group, i === 0))}`
					}
				</div>
			</div>
		`;
	}
}
