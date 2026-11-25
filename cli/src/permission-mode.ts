/**
 * The permission mode as the CLI reads and names it (docs/decisions.md, D67): Manual, Auto (the default) or Yolo. The
 * extension keeps the one store; the CLI only reads it in `status` and writes it through the bridge.
 */
export type PermissionMode = "manual" | "auto" | "yolo";
export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "yolo"];

/** A mode by name, or the 1.4.0 name an older extension reports ("ask", "by_model", "allow_all"). */
export function asPermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "manual" || value === "auto" || value === "yolo") return value;
	if (value === "ask") return "manual";
	if (value === "allow_all") return "yolo";
	if (value === "by_model") return "auto";
	return undefined;
}

/** The mode's name as a person reads it. */
export const MODE_TITLE: Record<PermissionMode, string> = { manual: "Manual", auto: "Auto", yolo: "Yolo" };

/** One line on what the mode lets agents do, for `status` and `doctor`. */
export function modeSummary(mode: PermissionMode): string {
	if (mode === "manual") return "agents ask before opening a site you haven't allowed";
	if (mode === "yolo") return "agents open any site without asking";
	return "frontier models open ordinary sites; small or unknown models, and sensitive sites, ask first";
}
