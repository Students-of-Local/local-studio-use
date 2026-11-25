/**
 * The side panel's Runs view (log.ts has what the log holds): every run, newest first, with its status and tab. A run
 * opens to its step timeline, and a step opens to its change report. The view follows the log as the worker writes it.
 */

import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ArrowLeft, Check, ChevronRight, X } from "lucide";
import { parseLog, RUNS_KEY, type Run, type RunStep, type RunsLog, STATUS_LABEL } from "./log.js";

let log: RunsLog = { runs: [] };
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;
const openRuns = new Set<string>();
const openSteps = new Set<string>();

/** Load the log and call `onChange` whenever the worker writes it. */
export async function watchRuns(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	loading ??= chrome.storage.local.get(RUNS_KEY).then((data) => {
		log = parseLog(data[RUNS_KEY]);
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "local" || !(RUNS_KEY in changes)) return;
			log = parseLog(changes[RUNS_KEY].newValue);
			for (const l of listeners) l();
		});
	});
	await loading;
	onChange();
	return () => listeners.delete(onChange);
}

/** Runs waiting on the user, for the header button's badge. */
export function runsWaiting(): number {
	return log.runs.filter((r) => r.status === "waiting").length;
}

function ago(at: number, now: number): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

function step(run: Run, s: RunStep, i: number, rerender: () => void): TemplateResult {
	const key = `${run.id}:${s.at}:${i}`;
	const open = openSteps.has(key);
	const toggle = () => {
		if (open) openSteps.delete(key);
		else openSteps.add(key);
		rerender();
	};
	return html`<li class="tk-run-step" data-ok=${String(s.ok)} data-tool=${s.tool}>
		<button
			type="button"
			class="tk-run-step-row"
			aria-expanded=${s.report ? String(open) : nothing}
			?disabled=${!s.report}
			@click=${toggle}
		>
			<span class="tk-run-step-mark" aria-label=${s.ok ? "Worked" : "Failed"}>${icon(s.ok ? Check : X, "xs")}</span>
			<span class="tk-run-step-tool">${s.tool}</span>
			<span class="tk-run-step-target" title=${s.target}>${s.target}</span>
			<span class="tk-run-step-ms">${ms(s.ms)}</span>
		</button>
		<div class="tk-run-step-result" title=${s.result}>${s.result}</div>
		${open && s.report ? html`<pre class="tk-run-report" data-report>${s.report}</pre>` : nothing}
	</li>`;
}

function run(r: Run, now: number, rerender: () => void): TemplateResult {
	const open = openRuns.has(r.id);
	const toggle = () => {
		if (open) openRuns.delete(r.id);
		else openRuns.add(r.id);
		rerender();
	};
	const count = r.steps.length + r.dropped;
	return html`<li class="tk-run" data-run=${r.id} data-status=${r.status}>
		<button type="button" class="tk-run-head" aria-expanded=${String(open)} @click=${toggle}>
			<span class="tk-run-chevron" aria-hidden="true">${icon(ChevronRight, "xs")}</span>
			<span class="min-w-0 flex-1">
				<span class="flex items-center gap-2">
					<span class="tk-run-who">${r.who}</span>
					<span class="tk-run-status" data-status=${r.status}>${STATUS_LABEL[r.status]}</span>
				</span>
				<span class="tk-run-meta">
					${r.tabTitle ? html`<span class="truncate" title=${r.tabTitle}>${r.tabTitle}</span><span aria-hidden="true">·</span>` : nothing}
					<span class="shrink-0">${count} ${count === 1 ? "step" : "steps"}</span>
					<span aria-hidden="true">·</span>
					<span class="shrink-0">${ago(r.updatedAt, now)}</span>
				</span>
			</span>
		</button>
		${
			open
				? html`<ol class="tk-run-steps" aria-label=${`Steps of ${r.who}`}>
					${r.dropped ? html`<li class="tk-run-dropped">${r.dropped} earlier ${r.dropped === 1 ? "step" : "steps"} not kept</li>` : nothing}
					${r.steps.map((s, i) => step(r, s, i, rerender))}
				</ol>`
				: nothing
		}
	</li>`;
}

/** The view, in place of the chat. */
export function runsView(onClose: () => void, rerender: () => void): TemplateResult {
	const now = Date.now();
	return html`<section class="flex-1 min-h-0 flex flex-col" aria-label="Runs" data-testid="runs-view">
		<div class="flex items-center gap-1 px-2 h-10 border-b border-border shrink-0">
			<button type="button" class="tk-icon-btn" aria-label="Back to chat" data-tip="Back to chat" @click=${onClose}>
				${icon(ArrowLeft, "sm")}
			</button>
			<h2 class="text-sm font-semibold">Runs</h2>
		</div>
		${
			log.runs.length === 0
				? html`<p class="p-4 text-sm text-muted-foreground">
						No runs yet. When an agent or this panel works in a tab, each step shows here.
					</p>`
				: html`<ol class="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
						${repeat(
							log.runs,
							(r) => r.id,
							(r) => run(r, now, rerender),
						)}
					</ol>`
		}
	</section>`;
}
