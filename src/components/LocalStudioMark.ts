import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { LOCAL_STUDIO_MARK } from "./local-studio-svg.js";
import { uniqueSvgIds } from "./svg-ids.js";

/** Local Studio's mark at `size` pixels. Each copy gets its own gradient ids. */
export function localStudioMark(size: number, className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(uniqueSvgIds(LOCAL_STUDIO_MARK))}</span
	>`;
}
