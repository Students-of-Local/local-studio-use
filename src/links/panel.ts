/** Links in the side panel: what a click does, the cards of buttons agents offered, and a Settings section one opened. */

import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { X } from "lucide";
import "./LinkButton.js";
import { type Link, linkText, parseLink, SECTIONS } from "./parse.js";
import {
	LINKS_PORT,
	type LinkReply,
	type LinkRequest,
	OFFER_MS,
	OFFERS_KEY,
	type Offer,
	SHOW_SETTINGS_KEY,
	type ShowSettings,
} from "./types.js";

const ANSWER_MS = 15_000;

let port: chrome.runtime.Port | undefined;
let seq = 0;
const waiting = new Map<number, (reply: Omit<LinkReply, "id">) => void>();
let showSection: (section: string) => void = () => undefined;

const lost = { error: { code: "internal", message: "Local Studio's background worker went away. Try again." } };

function connect(): chrome.runtime.Port {
	if (port) return port;
	const next = chrome.runtime.connect({ name: LINKS_PORT });
	next.onMessage.addListener((reply: LinkReply) => waiting.get(reply.id)?.(reply));
	next.onDisconnect.addListener(() => {
		if (port === next) port = undefined;
		for (const done of [...waiting.values()]) done(lost);
	});
	port = next;
	return next;
}

/** Run a link the person clicked; the sentence that says what happened. Call it in the click itself. */
export async function runLink(link: Link): Promise<string> {
	if (link.kind === "settings") {
		showSection(SECTIONS[link.section]);
		return "";
	}
	if (navigator.userActivation?.isActive !== true) throw new Error("Click the button again.");
	const id = ++seq;
	const request: LinkRequest = {
		id,
		link: linkText(link),
		gesture: { token: crypto.randomUUID(), at: Date.now() },
	};
	const reply = await new Promise<Omit<LinkReply, "id">>((resolve) => {
		const timer = setTimeout(() => finish(lost), ANSWER_MS);
		const finish = (answer: Omit<LinkReply, "id">) => {
			clearTimeout(timer);
			waiting.delete(id);
			resolve(answer);
		};
		waiting.set(id, finish);
		connect().postMessage(request);
	});
	if (reply.error) throw new Error(reply.error.message);
	return reply.done ?? "";
}

let offers: Offer[] = [];
const fresh = (value: unknown): Offer[] =>
	(Array.isArray(value) ? (value as Offer[]) : []).filter((o) => Date.now() - o.at < OFFER_MS);

/** Load what agents offered and follow it; `show` opens Settings on a section. */
export async function watchLinks(onChange: () => void, show: (section: string) => void): Promise<void> {
	showSection = show;
	// Tells the worker a panel is open, so it needs no badge.
	connect();
	const take = (value: unknown) => {
		const asked = value as ShowSettings | undefined;
		if (!asked || Date.now() - asked.at > 10 * 60_000) return;
		void chrome.storage.session.remove(SHOW_SETTINGS_KEY);
		show(asked.section);
	};
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session") return;
		if (OFFERS_KEY in changes) {
			offers = fresh(changes[OFFERS_KEY].newValue);
			onChange();
		}
		if (changes[SHOW_SETTINGS_KEY]?.newValue) take(changes[SHOW_SETTINGS_KEY].newValue);
	});
	const data = await chrome.storage.session.get([OFFERS_KEY, SHOW_SETTINGS_KEY]);
	offers = fresh(data[OFFERS_KEY]);
	onChange();
	take(data[SHOW_SETTINGS_KEY]);
}

async function dismiss(offer: Offer): Promise<void> {
	const data = await chrome.storage.session.get(OFFERS_KEY);
	const list = fresh(data[OFFERS_KEY]).filter((o) => o.clientId !== offer.clientId || o.at !== offer.at);
	await chrome.storage.session.set({ [OFFERS_KEY]: list });
}

/** The cards, newest last; nothing when no agent offers anything. */
export function offerCards(): TemplateResult | typeof nothing {
	const open = fresh(offers);
	if (open.length === 0) return nothing;
	return html`<div class="shrink-0 px-3 py-2 space-y-2 border-b border-border" data-testid="offers">
		${repeat(
			open,
			(o) => `${o.clientId}:${o.at}`,
			(
				o,
			) => html`<section class="tk-ask-card tk-ask-done" role="group" aria-label=${`${o.agentName} offers`} data-testid="offer-card">
				<div class="flex items-start gap-2 text-sm">
					<p class="min-w-0 flex-1 break-words">
						<span class="font-semibold text-foreground">${o.agentName}</span>
						${o.note ? html`<span class="text-foreground">${o.note}</span>` : nothing}
					</p>
					<button
						type="button"
						class="tk-icon-btn -mr-1.5 -mt-1.5"
						aria-label="Dismiss"
						title="Dismiss"
						data-action="dismiss"
						@click=${() => void dismiss(o)}
					>
						${icon(X, "sm")}
					</button>
				</div>
				<div class="mt-2 flex flex-wrap gap-1.5">
					${o.links.map((text) => {
						const link = parseLink(text);
						return link ? html`<local-studio-link .link=${link}></local-studio-link>` : nothing;
					})}
				</div>
			</section>`,
		)}
	</div>`;
}
