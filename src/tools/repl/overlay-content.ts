import { LOCAL_STUDIO_MARK_MONO } from "../../components/local-studio-svg.js";

/**
 * The bar's look: the side panel's own tokens, the default preset's light and dark palettes (src/appearance/palettes.ts),
 * mini-lit's type and radii, and its small danger button. The page has no panel tokens, so they are copied here.
 */
const BAR_CSS = `
.bar {
	--bg: #fffdf9;
	--fg: #1f1418;
	--muted: #76655f;
	--border: #eadfd0;
	--mark: #b8512a;
	--ring: #b8512a;
	--danger: #b3261e;
	--on-danger: #ffffff;
	--shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 8px 24px -4px rgb(0 0 0 / 0.18);
}
@media (prefers-color-scheme: dark) {
	.bar {
		--bg: #1f151a;
		--fg: #f3ebdd;
		--muted: #9e8d89;
		--border: #2a1d23;
		--mark: #dc6f42;
		--ring: #dc6f42;
		--danger: #f26b6b;
		--on-danger: #000000;
		--shadow: 0 8px 24px -4px rgb(0 0 0 / 0.45);
	}
}
.bar, .bar * { box-sizing: border-box; }
.bar { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 1; pointer-events: auto;
	display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 8px 0 16px;
	width: max-content; max-width: min(560px, calc(100vw - 32px));
	background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
	font: 500 14px/20px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; }
.mark { flex: none; display: block; width: 20px; height: 20px; color: var(--mark); }
.mark svg { display: block; width: 20px; height: 20px; }
.text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.text b { font-weight: 600; }
.task { font-weight: 400; color: var(--muted); }
button { all: unset; box-sizing: border-box; flex: none; display: inline-flex; align-items: center; justify-content: center;
	height: 32px; padding: 0 12px; border-radius: 8px; font: inherit; font-size: 12px; line-height: 16px;
	background: var(--danger); color: var(--on-danger); cursor: pointer; }
button:hover { background: color-mix(in srgb, var(--danger) 90%, transparent); }
button:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent); }
/* A faint amber edge while the script runs, still, as the app's own window glow is. */
.glow { position: absolute; inset: 0; box-shadow: inset 0 0 120px 20px rgb(220 111 66 / 0.14); }
`;

/**
 * This code gets stringified and injected into the page context.
 * Creates a full-viewport overlay with an amber edge and the bar that stops the script.
 */
export function createOverlayScript(taskName: string): string {
	return `
(function() {
	// Check if overlay already exists (prevent duplicates)
	if (document.getElementById('local-studio-repl-overlay')) {
		return;
	}

	// A tag no site styles, with its style reset inline, holding everything in its own shadow root: a site's CSS (button
	// padding, line-height, fonts) never reaches the bar.
	const host = document.createElement('local-studio-repl-overlay');
	host.id = 'local-studio-repl-overlay';
	host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
	const root = host.attachShadow({ mode: 'open' });
	const overlay = document.createElement('div');
	overlay.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';

	const glow = document.createElement('div');
	glow.className = 'glow';

	// The bar: Local Studio's mark and name with the task on one line, clipped (the whole task on hover), and Stop.
	const toolbar = document.createElement('div');
	toolbar.className = 'bar';
	toolbar.innerHTML = '<span class="mark" aria-hidden="true">' + ${JSON.stringify(LOCAL_STUDIO_MARK_MONO)} +
		'</span><span class="text" role="status"><b>Local Studio</b><span class="task"></span></span>' +
		'<button type="button" aria-label="Stop the script Local Studio is running">Stop</button>';
	const task = ${JSON.stringify(taskName)};
	toolbar.querySelector('.task').textContent = ' \u00b7 ' + task;
	toolbar.querySelector('.text').title = task;
	const abortBtn = toolbar.querySelector('button');
	abortBtn.onclick = async (event) => {
		// Only a person's click stops the script: the page can't press it for them.
		if (!event.isTrusted) return;
		try {
			await chrome.runtime.sendMessage({ type: 'abort-repl' });
		} catch (error) {
			console.error('[Overlay] sendMessage failed:', error);
		}
		host.remove();
	};

	// Assemble overlay
	overlay.appendChild(glow);
	overlay.appendChild(toolbar);

	const style = document.createElement('style');
	style.textContent = ${JSON.stringify(BAR_CSS)};
	root.appendChild(style);
	root.appendChild(overlay);
	(document.body || document.documentElement).appendChild(host);
})();
`;
}

/**
 * Code to remove the overlay from the page.
 */
export function removeOverlayScript(): string {
	return `
(function() {
	const overlay = document.getElementById('local-studio-repl-overlay');
	if (overlay) {
		overlay.remove();
	}
})();
`;
}
