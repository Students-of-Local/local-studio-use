/**
 * What a person types to run the helper, the same name in a release, an npm link and the app. Someone who just installed from
 * the store has no helper yet, so the screens that show this also say how to get it.
 */
export function hostCommand(): string {
	return "local-studio-browser";
}

/** The command for a sentence. */
export function hostCommandText(subcommand: string): string {
	return `${hostCommand()} ${subcommand}`;
}
