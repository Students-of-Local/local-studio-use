/** One link as a button. Its words come from the link itself, and only a real click runs it. */

import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { AppWindow, Check, FileText, FolderOpen, Globe, type IconNode, Settings, Zap } from "lucide";
import { runLink } from "./panel.js";
import { type Link, linkLabel, linkTitle, parseLink } from "./parse.js";

const ICONS: Record<Link["kind"], IconNode> = {
	settings: Settings,
	system: Settings,
	browser: Globe,
	app: AppWindow,
	file: FileText,
	reveal: FolderOpen,
	shortcut: Zap,
};

export function platform(): "mac" | "win" | "linux" {
	const name = navigator.platform ?? "";
	return /^mac/i.test(name) ? "mac" : /^win/i.test(name) ? "win" : "linux";
}

@customElement("local-studio-link")
export class LinkButton extends LitElement {
	@property({ attribute: false }) link?: Link;
	@state() private at: "idle" | "confirm" | "busy" | "done" = "idle";
	@state() private problem = "";
	private back?: ReturnType<typeof setTimeout>;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearTimeout(this.back);
	}

	private later(ms: number): void {
		clearTimeout(this.back);
		this.back = setTimeout(() => {
			this.at = "idle";
		}, ms);
	}

	private async press(event: MouseEvent): Promise<void> {
		if (!event.isTrusted || !this.link || this.at === "busy") return;
		this.problem = "";
		// A shortcut can do anything its owner made it do: one click names it, a second runs it.
		if (this.link.kind === "shortcut" && this.at !== "confirm") {
			this.at = "confirm";
			return this.later(6000);
		}
		this.at = "busy";
		try {
			await runLink(this.link);
			this.at = "done";
			this.later(2000);
		} catch (err) {
			this.at = "idle";
			this.problem = err instanceof Error ? err.message : String(err);
		}
	}

	/** What can't open from a link can still be shown in its folder. */
	private get instead(): Link | undefined {
		return this.problem && this.link?.kind === "file" ? { kind: "reveal", path: this.link.path } : undefined;
	}

	protected override render(): TemplateResult | typeof nothing {
		const { link } = this;
		if (!link) return nothing;
		const label = linkLabel(link, platform());
		return html`<button
				type="button"
				class="tk-link"
				title=${linkTitle(link) ?? label}
				data-link=${link.kind}
				data-state=${this.at}
				?disabled=${this.at === "busy"}
				@click=${(e: MouseEvent) => void this.press(e)}
			>
				<span class="tk-link-icon" aria-hidden="true">${icon(this.at === "done" ? Check : ICONS[link.kind], "xs")}</span>
				<span class="min-w-0 truncate">${this.at === "confirm" ? `Run “${"name" in link ? link.name : ""}” now?` : label}</span>
			</button>
			${
				this.problem
					? html`<span class="block text-xs text-destructive mt-1" role="alert">${this.problem}</span>`
					: nothing
			}
			${this.instead ? html`<local-studio-link .link=${this.instead}></local-studio-link>` : nothing}`;
	}
}

/**
 * An answer's links become buttons, and one that isn't a link of ours becomes its own words, so no text in an answer can
 * send the computer anywhere through a `localstudio:` address. Called each time the answer has drawn.
 */
export function drawLinks(root: ParentNode): void {
	for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const href = a.getAttribute("href") ?? "";
		if (!/^\s*localstudio[a-z-]*:/i.test(href)) continue;
		const link = parseLink(href);
		if (!link) {
			a.replaceWith(...a.childNodes);
			continue;
		}
		const button = document.createElement("local-studio-link") as LinkButton;
		button.link = link;
		a.replaceWith(button);
	}
}

/** The same addresses anywhere else in the panel (a person's message, a tool's result) do nothing. */
export function blockOtherLinks(): void {
	const stop = (event: Event) => {
		const a = (event.target as Element | null)?.closest?.("a[href]");
		if (a && /^\s*localstudio[a-z-]*:/i.test(a.getAttribute("href") ?? "")) event.preventDefault();
	};
	for (const type of ["click", "auxclick"]) document.addEventListener(type, stop, true);
}

@customElement("local-studio-answer")
export class Answer extends LitElement {
	@property({ attribute: false }) text = "";

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	protected override render(): TemplateResult {
		return html`<markdown-block .content=${this.text}></markdown-block>`;
	}

	protected override async updated(): Promise<void> {
		const block = this.querySelector("markdown-block") as
			| (HTMLElement & { updateComplete?: Promise<unknown> })
			| null;
		await block?.updateComplete;
		if (block) drawLinks(block);
	}
}
