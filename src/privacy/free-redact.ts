/**
 * What Free mode takes out before anything reaches a free model, since those may keep what they get: keys, card numbers
 * and US Social Security numbers. Only text can be cleaned. Addresses and long ids stay, because the agent has to use them,
 * and screenshots go as they are; the consent text says so.
 */
import { redactKnownSecrets } from "./bug-reports.js";

function passesLuhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

/** A number a card can have: its first digits and length, then the check digit. Ids, timestamps and ISBNs start with 1 or 9. */
function isCard(digits: string): boolean {
	const shape =
		/^(?:3[47]\d{13}|3[0689]\d{12}(?:\d\d)?|35\d{14}|4(?:\d{12}|\d{15}|\d{18})|5\d{15}|2[2-7]\d{14}|6\d{15,18}|8[12]\d{14}|9792\d{12})$/;
	return shape.test(digits) && passesLuhn(digits);
}

/**
 * Card numbers in a run of digit groups. A card sits beside its expiry, CVV or another number as often as alone, so every
 * stretch of whole groups that has a card's length is checked, not only the run. A stretch inside a longer run needs
 * groups of three digits or more, so a calendar's days or a list of years stays.
 */
function redactCards(run: string): string {
	const groups = [...run.matchAll(/\d+/g)];
	const card = groups.map(() => false);
	for (let i = 0; i < groups.length; i++) {
		let digits = "";
		for (let j = i; j < groups.length && digits.length < 19; j++) {
			digits += groups[j][0];
			if (!isCard(digits)) continue;
			const whole = i === 0 && j === groups.length - 1;
			if (whole || groups.slice(i, j + 1).every((g) => g[0].length > 2)) card.fill(true, i, j + 1);
		}
	}
	let out = "";
	let end = 0;
	groups.forEach((g, i) => {
		if (!card[i]) out += run.slice(end, g.index) + g[0];
		else if (!card[i - 1]) out += `${run.slice(end, g.index)}[card number]`;
		end = g.index + g[0].length;
	});
	return out;
}

export function redactForFree(text: string): string {
	return redactKnownSecrets(text)
		.replace(/\b\d(?:[ \u00a0-]{0,2}\d){12,}\b/g, redactCards)
		.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
}

/** Every string and number inside a tool call's arguments, cleaned. */
function redactDeep(value: unknown): unknown {
	if (typeof value === "string") return redactForFree(value);
	if (Number.isInteger(value)) {
		const clean = redactForFree(String(value));
		return clean === String(value) ? value : clean;
	}
	if (Array.isArray(value)) return value.map(redactDeep);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
}

type Part = { type?: string; text?: string; thinking?: string; arguments?: unknown } & Record<string, unknown>;
type Message = { content?: string | Part[] } & Record<string, unknown>;

/** A copy of the conversation with every text, thinking and tool call part cleaned. The chat the person sees keeps the original. */
export function redactContext<C>(context: C): C {
	const messages = (context as { messages?: Message[] }).messages;
	if (!Array.isArray(messages)) return context;
	return {
		...context,
		messages: messages.map((m) => {
			if (typeof m.content === "string") return { ...m, content: redactForFree(m.content) };
			if (!Array.isArray(m.content)) return m;
			return {
				...m,
				content: m.content.map((p) => ({
					...p,
					...(typeof p.text === "string" ? { text: redactForFree(p.text) } : {}),
					...(typeof p.thinking === "string" ? { thinking: redactForFree(p.thinking) } : {}),
					...(p.arguments === undefined ? {} : { arguments: redactDeep(p.arguments) }),
				})),
			};
		}),
	};
}
