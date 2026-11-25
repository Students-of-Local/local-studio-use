import { FileText, Globe, type IconNode, Paintbrush, TextCursorInput } from "lucide";

export interface StarterPrompt {
	label: string;
	/** One short line under the label: what the chip does. */
	hint: string;
	icon: IconNode;
	prompt: string;
	/**
	 * "send" runs the prompt at once. "compose" puts it in the chat input for the user to finish
	 * (the topic, the form's details). "sites" opens Settings > Sites on the page in front of them.
	 */
	mode: "send" | "compose" | "sites";
}

/** The empty chat's starter chips: what Local Studio does best, each a task that runs as is. */
export const starters: StarterPrompt[] = [
	{
		label: "Summarize page",
		hint: "The tab you're on",
		icon: FileText,
		mode: "send",
		prompt:
			"Read the page in my current tab and summarize it: what it is, the key points, and anything I should act on. Quote the page where it matters.",
	},
	{
		label: "Research a topic",
		hint: "Every claim linked",
		icon: Globe,
		mode: "compose",
		prompt: "Research this and link a source for every claim: ",
	},
	{
		label: "Fill a form",
		hint: "Stops before submit",
		icon: TextCursorInput,
		mode: "compose",
		prompt: "Fill in the form on this page with these details, then stop before submitting so I can check it: ",
	},
	{
		label: "Change this site",
		hint: "Hide, filter, restyle",
		icon: Paintbrush,
		mode: "sites",
		prompt: "",
	},
];
