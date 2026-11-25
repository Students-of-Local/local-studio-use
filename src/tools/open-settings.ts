/** open_settings for the side panel's own agent: the same settings places an outside agent can open (src/links/worker.ts). */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { BROWSER_PAGES, PANES, parsePlace, SECTIONS } from "../links/parse.js";
import { OPEN_PLACE } from "../links/types.js";

const schema = Type.Object({
	place: Type.String({ description: 'e.g. "settings/Skills", "browser/extensions", "system/displays"' }),
});

export class OpenSettingsTool implements AgentTool<typeof schema, undefined> {
	label = "Open settings";
	name = "open_settings";
	description = `Open a settings page for the user, when they ask for it or must change something there themselves. It changes nothing. place: settings/<${Object.values(SECTIONS).join("|")}> (Local Studio's own), browser/<${Object.keys(BROWSER_PAGES).join("|")}>, system/<${Object.keys(PANES).join("|")}> (the computer's).`;
	parameters = schema;

	async execute(
		_id: string,
		{ place }: Static<typeof schema>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
		if (!parsePlace(place)) throw new Error("That is not a settings place. Use one the tool's description names.");
		const answer = await chrome.runtime.sendMessage({ type: OPEN_PLACE, place });
		if (answer?.error) throw new Error(String(answer.error.message));
		return { content: [{ type: "text", text: String(answer?.done ?? "Done.") }], details: undefined };
	}
}
