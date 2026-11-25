// Recall of Auto's risky-action rules (src/bridge/risk-rules.ts, D67) on the labeled cases (README.md). It reads the
// rules' TypeScript, so it runs under tsx:
//   node --import tsx evals/market/risky-actions/score.mjs           the score, the misses and the false flags
//   node --import tsx evals/market/risky-actions/score.mjs --json    the market eval's score line (run.mjs reads it)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRiskyAction } from "../../../src/bridge/risk-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function loadCases() {
	return readFileSync(join(here, "cases.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/** `button "Send"` as read_page shows it: the role, then the name in quotes. */
export function parseTarget(target) {
	const m = /^([a-z]+)\s*(?:"(.*)")?$/i.exec((target ?? "").trim());
	return m ? { role: m[1], name: m[2] ?? "" } : {};
}

/** A case as the facts the bridge gathers before an action. */
export function factsOf(c) {
	return {
		tool: c.tool,
		url: c.url,
		key: c.key,
		submit: c.submit,
		target: {
			...parseTarget(c.target),
			...(c.inputType ? { inputType: c.inputType } : {}),
			...(c.autocomplete ? { autocomplete: c.autocomplete } : {}),
			...(c.href ? { href: c.href } : {}),
			...(c.dialog ? { dialog: c.dialog } : {}),
			...(c.form ? { form: c.form } : {}),
			...(c.frameUrl ? { frameUrl: c.frameUrl } : {}),
		},
	};
}

/** Recall on `risky: true` cases (the floor) and the false-flag rate on `risky: false` ones (reported). */
export function score(cases, isRisky = (c) => isRiskyAction(factsOf(c))) {
	const risky = cases.filter((c) => c.risky);
	const safe = cases.filter((c) => !c.risky);
	const caught = risky.filter((c) => isRisky(c));
	const flagged = safe.filter((c) => isRisky(c));
	return {
		cases: cases.length,
		risky: risky.length,
		caught: caught.length,
		recall: risky.length ? caught.length / risky.length : null,
		falseFlagRate: safe.length ? flagged.length / safe.length : null,
		missed: risky.filter((c) => !isRisky(c)).map((c) => c.id),
		falseFlags: flagged.map((c) => c.id),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const s = score(loadCases());
	if (process.argv.includes("--json")) console.log(JSON.stringify(s));
	else {
		console.log(`${s.caught}/${s.risky} risky actions caught (recall ${(s.recall * 100).toFixed(1)}%), ${s.cases} cases`);
		console.log(`false flags: ${s.falseFlags.length} of ${s.cases - s.risky} safe cases${s.falseFlags.length ? `: ${s.falseFlags.join(", ")}` : ""}`);
		if (s.missed.length) console.log(`missed: ${s.missed.join(", ")}`);
	}
}
