/**
 * Hand-back cards at the top of every open side panel (state.ts has the flow): "Claude needs you", what to do, the
 * tab, and two buttons. Show tab brings the tab forward, the one focus change, made by the user's click. Continue
 * answers the agent, which goes on.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { Hand } from "lucide";
import { Toast } from "../components/Toast.js";
import { openSignIn } from "./sign-in.js";
import { CONTINUE_KEY_PREFIX, HANDBACK_KEY, openHandbacks, type PendingHandback } from "./state.js";

let pending: PendingHandback[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

/** Load the open hand-backs and call `onChange` whenever they change. */
export async function watchHandbacks(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= chrome.storage.session.get(HANDBACK_KEY).then((data) => {
		pending = openHandbacks(data[HANDBACK_KEY], Date.now());
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "session" || !(HANDBACK_KEY in changes)) return;
			pending = openHandbacks(changes[HANDBACK_KEY].newValue, Date.now());
			for (const l of listeners) l();
		});
	});
	await loading;
	onChange();
	return () => listeners.delete(onChange);
}

/** How many hand-backs wait on the user now. */
export function handbackCount(): number {
	return openHandbacks(pending, Date.now()).length;
}

async function pressContinue(p: PendingHandback): Promise<void> {
	const data = await chrome.storage.session.get(HANDBACK_KEY);
	if (!openHandbacks(data[HANDBACK_KEY], Date.now()).some((q) => q.id === p.id)) {
		Toast.info("That wait has already ended.");
		return;
	}
	await chrome.storage.session.set({ [`${CONTINUE_KEY_PREFIX}${p.id}`]: Date.now() });
	Toast.success(`${p.agent} is going on`);
}

async function showTab(p: PendingHandback): Promise<void> {
	try {
		const tab = await chrome.tabs.update(p.tabId, { active: true });
		if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
	} catch {
		Toast.info("That tab is closed.");
	}
}

/** The cards, oldest first; nothing when no agent waits on the user. */
export function handbackCards(): TemplateResult | typeof nothing {
	const open = openHandbacks(pending, Date.now());
	if (open.length === 0) return nothing;
	return html`<div class="shrink-0 px-3 py-2 space-y-2 border-b border-border" data-testid="handbacks">
		${repeat(
			open,
			(p) => p.id,
			(p) => html`<section
				class="tk-ask-card"
				role="group"
				aria-label=${`${p.agent} needs you`}
				data-testid="handback-card"
				data-handback=${p.id}
			>
				<div class="flex items-center gap-2 text-sm">
					<span class="tk-ask-icon" aria-hidden="true">${icon(Hand, "sm")}</span>
					<span class="font-semibold text-foreground min-w-0 truncate">${p.agent} needs you</span>
					<span class="ml-auto shrink-0 tk-ask-chip">Your turn</span>
				</div>
				<p class="mt-1.5 text-sm text-foreground break-words" data-reason>${p.reason}</p>
				<p class="mt-0.5 text-xs text-muted-foreground truncate" title=${p.tabTitle}>${p.tabTitle}</p>
				<p class="mt-1.5 text-xs text-muted-foreground">
					${
						p.signIn
							? `Type it in the sign-in window for ${p.signIn.host}, or sign in on the page and press Continue.`
							: "Do it on the page, then press Continue."
					}
				</p>
				<div class="mt-3 flex items-center justify-end gap-2">
					<button type="button" class="tk-ask-btn tk-ask-btn-ghost" data-action="show-tab" @click=${() => showTab(p)}>
						Show tab
					</button>
					<button
						type="button"
						class="tk-ask-btn ${p.signIn ? "tk-ask-btn-ghost" : "tk-ask-btn-primary"}"
						data-action="continue"
						@click=${() => void pressContinue(p)}
					>
						Continue
					</button>
					${
						p.signIn
							? html`<button
								type="button"
								class="tk-ask-btn tk-ask-btn-primary"
								data-action="sign-in"
								@click=${() => void openSignIn(p.id, true).catch(() => Toast.info("The sign-in window didn't open."))}
							>
								Type sign-in
							</button>`
							: nothing
					}
				</div>
			</section>`,
		)}
	</div>`;
}
