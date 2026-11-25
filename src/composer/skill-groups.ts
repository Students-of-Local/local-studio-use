/**
 * The bundled skills, grouped by what a person wants done. Settings > Skills and the "/" menu both read this, in this
 * order. A bundled skill is in exactly one group (test/panel-ui.test.mjs); one added without a group shows under "More".
 */
export const SKILL_GROUPS: ReadonlyArray<{ name: string; skills: readonly string[] }> = [
	{
		name: "Browse and search",
		skills: ["local-studio-browser", "bulk-actions", "site-learning", "dorks", "summarize", "pdf", "annotation"],
	},
	{
		name: "Research",
		skills: ["academic-research", "autoresearch", "news-research", "osint", "world-data", "reference"],
	},
	{ name: "Science and math", skills: ["biology", "chemistry", "genetics", "mathematics"] },
	{
		name: "Writing and documents",
		skills: ["writing", "writing-voice", "office-docs", "notes", "visual-explainer", "artifacts"],
	},
	{
		name: "Design and making",
		skills: ["branding", "design-library", "pcb-design", "mechanism-design", "video-editing"],
	},
	{ name: "Mail and accounts", skills: ["email-organization", "proton", "proton-pass"] },
	{ name: "Sites", skills: ["youtube", "instagram", "rumble", "x-search"] },
	{ name: "Places", skills: ["maps", "map-data"] },
	{ name: "Local Studio", skills: ["connector", "bug", "fix", "rsi", "adversarial-review"] },
];

export const UNGROUPED = "More";

const GROUP_OF = new Map(SKILL_GROUPS.flatMap((group) => group.skills.map((skill) => [skill, group.name])));

/** The items of each group that has any, in the groups' order; what no group names comes last. */
export function bySkillGroup<T extends { name: string }>(items: readonly T[]): Array<{ name: string; items: T[] }> {
	const names = [...SKILL_GROUPS.map((group) => group.name), UNGROUPED];
	return names
		.map((name) => ({ name, items: items.filter((item) => (GROUP_OF.get(item.name) ?? UNGROUPED) === name) }))
		.filter((group) => group.items.length > 0);
}
