/**
 * Dollar amounts in the agent's text read as prices, not math. The markdown renderer treats
 * "$...$" as inline LaTeX, so "costs $89, and $4 less" became a formula with the words run
 * together. A "$" right before a number is escaped, unless the number goes on into math
 * ("$2^{10}$", "$3x+1$", "$1/2$"). A unit ("$20/month", "$3/1M tokens"), a trailing "+" and a
 * currency code keep it a price, in bold too. Code spans and fenced blocks are left as they are.
 */
const AMOUNT = String.raw`\d[\d,]*(?:\.\d+)?(?:[kKmMbB]n?)?`;
/** What may follow an amount in a price though it could start math: "+", a currency code, "/" and a unit. */
const PRICE_TAIL = String.raw`\+?(?:USD|CAD|AUD|NZD|HKD|SGD|MXN|EUR|GBP)?(?:/(?:1?[kKM] ?tokens?|1[kKM]|[A-Za-z]{3,}|mo|yr|hr|wk|lb|kg|oz|[kKmMgGtT][bB]|mi|km))*(?![\w^{}\\=+/$(]|\*(?!\*))`;
const PRICE = new RegExp(String.raw`(?<![\\$])\$(?=${AMOUNT}${PRICE_TAIL})`, "g");

export function escapeCurrency(text: string): string {
	if (!text.includes("$")) return text;
	// Split out fenced blocks and inline code; only the prose between them is touched.
	return text
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
		.map((part, i) => (i % 2 === 1 ? part : part.replace(PRICE, "\\$")))
		.join("");
}
