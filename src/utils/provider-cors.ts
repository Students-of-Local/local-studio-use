/**
 * The panel reaches a model provider with the extension's own host permissions, which need no CORS header. 1.4.0 and earlier
 * added a dynamic rule with permissive CORS headers for each custom provider's host; those rules outlive an update, so each
 * worker start takes away any that are left.
 */

const RULE_ID_BASE = 2000;
const RULE_ID_MAX = 2999;

export async function removeProviderCorsRules(): Promise<void> {
	const dnr = chrome.declarativeNetRequest;
	if (!dnr?.updateDynamicRules) return;
	const removeRuleIds = (await dnr.getDynamicRules())
		.map((rule) => rule.id)
		.filter((id) => id >= RULE_ID_BASE && id <= RULE_ID_MAX);
	if (removeRuleIds.length) await dnr.updateDynamicRules({ removeRuleIds });
}
