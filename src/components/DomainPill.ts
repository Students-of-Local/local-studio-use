import { html, type TemplateResult } from "lit";

export function DomainPill(domain: string): TemplateResult {
	return html`
		<div class="inline-flex items-center px-2 py-1 text-xs bg-muted/50 border border-border rounded">
			<code class="text-muted-foreground">${domain}</code>
		</div>
	`;
}
