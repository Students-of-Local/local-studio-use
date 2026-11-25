/** Environment variables the helper reads, all `LOCAL_STUDIO_BROWSER_<name>`. Read through here, never `process.env.LOCAL_STUDIO_BROWSER_*` directly. */

/** The variable `name` (without prefix) from `source`, when set and not empty. */
export function envVar(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
	return source[`LOCAL_STUDIO_BROWSER_${name}`] || undefined;
}

/** True when the variable is set to something non-empty. */
export function envSet(name: string, source: Record<string, string | undefined> = process.env): boolean {
	return envVar(name, source) !== undefined;
}
