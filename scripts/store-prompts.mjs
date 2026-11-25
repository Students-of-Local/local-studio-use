// The store build's copy of pi-web-ui's tool prompts (vendor/pi-mono/packages/web-ui/src/prompts/prompts.ts). Those tell
// the agent it may import any npm package from esm.run, ES modules from esm.sh and Tailwind from its CDN; the store build
// loads no code from outside its package, so scripts/build.mjs rewrites them, when LOCAL_STUDIO_BROWSER_STORE_BUILD=1, to name the
// libraries it packs (src/prompts/sandbox-libraries.json) instead. The release build keeps pi-web-ui's text.
import { CDN_HOSTS } from "./store-package.mjs";

/** pi-web-ui's prompts module, rewritten for the store build. Throws when a line it replaces has moved or changed. */
export function storeVendorPrompts(source, libraries) {
	const specifiers = libraries.modules.map((m) => m.specifier);
	const tailwind = libraries.scripts.find((s) => s.package === "@tailwindcss/browser");
	const exact = [
		[
			"- Import any npm package: await import('https://esm.run/package-name')",
			`- Import only these bundled libraries, by name: ${specifiers.join(", ")}. Nothing loads from outside the extension.`,
		],
		[
			`- Import ES modules from esm.sh: <script type="module">import X from 'https://esm.sh/pkg';</script>`,
			`- Import only these bundled libraries, by name: ${specifiers.join(", ")}; for example <script type="module">import * as XLSX from 'xlsx';</script>. Nothing loads from outside the extension, so an artifact that uses them runs only inside this extension; say so when the user downloads one.`,
		],
		[
			'- Use Tailwind CDN: <script src="https://cdn.tailwindcss.com"></script>',
			`- Use Tailwind CSS v${tailwind.version}: ${tailwind.use} There is no tailwind.config; set theme values in <style type="text/tailwindcss">@theme { --color-brand: #2563eb; }</style>.`,
		],
	];
	let out = source;
	for (const [from, to] of exact) {
		if (!out.includes(from)) throw new Error(`pi-web-ui's prompts no longer say: ${from}`);
		out = out.replaceAll(from, to);
	}
	out = out.replace(/import\('https:\/\/esm\.run\/([^']+)'\)/g, (_, spec) => {
		if (!specifiers.includes(spec))
			throw new Error(`pi-web-ui's prompts import ${spec}, which the store build does not pack`);
		return `import('${spec}')`;
	});
	for (const host of CDN_HOSTS) if (out.includes(host)) throw new Error(`pi-web-ui's prompts still name ${host}`);
	return out;
}
