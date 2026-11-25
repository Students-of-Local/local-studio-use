import { i18n } from "@mariozechner/mini-lit";
import { customElement } from "lit/decorators.js";
import { PREVIEW_LIMITS } from "./preview/content.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";

/** PowerPoint (.pptx) preview: every slide drawn from the file's XML, no scripts, no network. */
@customElement("pptx-artifact")
export class PptxArtifact extends PreviewArtifact {
	protected override get errorTitle(): string {
		return i18n("Error loading presentation");
	}

	protected async renderPreview(container: HTMLElement) {
		const [{ mountDeck }, { readPptx }] = await Promise.all([
			import("./preview/deck-view.js"),
			import("./preview/pptx.js"),
		]);
		const deck = await readPptx(this.decodedContent(PREVIEW_LIMITS.maxDocumentBytes));
		return mountDeck(container, deck);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"pptx-artifact": PptxArtifact;
	}
}
