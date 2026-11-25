/**
 * Every `local-studio-browser` command, once. `--help`, the shell completions and the argument checks are all
 * generated from this table: a help row's flags are exactly the flags its subcommand accepts, so
 * help, completions and the parser can't disagree.
 */

import { SETUP_FLAGS, UPDATE_FLAGS } from "./parse-args.ts";
import { COMMAND_NAME } from "./self.ts";

export interface SubcommandSpec {
	name: string;
	/** Its positional arguments as help shows them ("<name>", "[path...]"). Flags are added from `flags`. */
	args?: string;
	what: string;
	flags?: string[];
	/** Positional arguments after the subcommand, at most (default 0). */
	max?: number;
	/** Its arguments are file or folder paths: completions fall back to file names there. */
	paths?: boolean;
	/** Value options whose value may be left out here (`remote setup --cloudflare` asks for the name in a terminal). */
	optionalValue?: string[];
}

export interface CommandSpec {
	/** The command word, e.g. "status" or "token". */
	name: string;
	/** Positional arguments as help shows them ("<host>", "[dir]"). Flags are added from `flags`. */
	args?: string;
	what: string;
	/** One line for the whole command in completions (commands with subcommands). */
	summary?: string;
	group: "Get started" | "Agents" | "Sessions" | "Remote" | "Library" | "Sites" | "Guests" | "Troubleshoot";
	flags?: string[];
	/** Second words (`hub setup`, `token list`); each gets its own help row and flags. */
	subcommands?: SubcommandSpec[];
	/** Arguments after the command a command takes at most (default 0). Ignored with subcommands. */
	positional?: number;
	/** Its arguments are paths: completions fall back to file names. */
	paths?: boolean;
	/** Value options that take no value here (`install --remove`; `link scopes --remove <scope>` takes one). */
	switches?: string[];
	/** The command parses its own arguments (setup, update, library); argsProblem leaves it alone. */
	selfParsed?: boolean;
	/** The subcommand a bare `local-studio-browser <name>` runs (`local-studio-browser sessions` lists). */
	defaultSubcommand?: string;
	/** Values completed for the first argument (`completion zsh`). */
	values?: string[];
	/** Hidden from help and completions (aliases, internal entry points). */
	hidden?: boolean;
}

/** Options that take a value (`--limit 3` or `--limit=3`), with the placeholder help shows. */
export const VALUE_HINTS: Record<string, string> = {
	"--offset": "N",
	"--limit": "N",
	"--session": "<name>",
	"--profile": "panel|small|full",
	"--tools": "browser,computer",
	"--port": "N",
	"--public-url": "https://host",
	"--cloudflare": "name.yourdomain.com",
	"--relay": "worker-name",
	"--account": "account-id",
	"--redirect-host": "a,b",
	"--allow-host": "a,b",
	"--scope": "a,b",
	"--name": "<name>",
	"--code": "TK-XXXX-XXXX",
	"--timeout": "<seconds>",
	"--channel": "stable|nightly",
	"--auto-check": "on|off",
	"--quote": "TEXT",
	"--location": "TEXT",
	"--note": "TEXT",
	"--tag": "TAG",
	"--style": "apa|mla|...",
	"--format": "<format>",
	"--out": "FILE",
	"--folder": "NAME",
	"--new-passcode-file": "<path>",
	"--browser": "<name>",
	"--add": "<scope>",
	"--remove": "<scope>",
	"--release": "<folder>",
};

export const VALUE_FLAGS = new Set(Object.keys(VALUE_HINTS));

/** Value options whose value is a path: completions offer file names after them. */
const PATH_VALUES = new Set(["--out", "--release", "--new-passcode-file"]);

export const COMMANDS: CommandSpec[] = [
	{ name: "setup", selfParsed: true, what: "Build, register, load, connect and add to your agents; --agents runs only the agent step", group: "Get started", flags: SETUP_FLAGS },
	{ name: "status", what: "Is the extension connected? Which sites are allowed?", group: "Get started", flags: ["--json"] },
	{ name: "mcp", what: "MCP server on stdio (what Claude Code, Codex, OpenCode run)", group: "Agents", flags: ["--session", "--profile", "--tools", "--name"] },
	{
		name: "copilot-sdk",
		summary: "GitHub's Copilot SDK, for the side panel's Copilot sign-in",
		what: "GitHub's Copilot SDK",
		group: "Agents",
		defaultSubcommand: "status",
		subcommands: [
			{ name: "install", what: "Install the pinned SDK (about 160 MB) for Sign in with GitHub Copilot" },
			{ name: "status", what: "Is the SDK installed?" },
		],
	},
	{ name: "pi-extension", positional: 1, paths: true, args: "[dir]", what: "Write a pi extension to ~/.pi/agent/extensions/local-studio.ts", group: "Agents" },
	{
		name: "sessions",
		summary: "Agent sessions and their tab groups",
		what: "Agent sessions",
		group: "Sessions",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", what: "Every agent session: group, tabs, connected or idle", flags: ["--all", "--json"] },
			{ name: "show", args: "<name>", what: "One session: its group, tabs, times, and how to resume it", flags: ["--json"], max: 1 },
			{ name: "rename", args: "<old> <new>", what: `Rename; resume it later with ${COMMAND_NAME} mcp --session <new>`, flags: ["--json"], max: 2 },
			{ name: "end", args: "<name>", what: "End it: its tabs become yours (or close, with --close)", flags: ["--close", "--json"], max: 1 },
			{ name: "release", args: "<name>", what: "Hand all its tabs to you, out of the group, and end it", flags: ["--json"], max: 1 },
			{ name: "focus", args: "<name>", what: "Show its group to you", flags: ["--json"], max: 1 },
			{ name: "collapse", args: "<name>", what: "Fold its group", flags: ["--json"], max: 1 },
			{ name: "expand", args: "<name>", what: "Unfold its group", flags: ["--json"], max: 1 },
		],
	},
	{
		name: "threads",
		summary: "Past side panel chats, for you and your agents",
		what: "Past side panel chats",
		group: "Sessions",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", args: "[words]", what: "Past chats, newest first (live, or from the local mirror)", flags: ["--json", "--offset", "--limit"], max: 64 },
			{ name: "show", args: "<id>", what: "One chat as text, 40 messages a page", flags: ["--json", "--offset", "--limit"], max: 1 },
			{ name: "search", args: "<words>", what: "Chats that mention all the words, with snippets", flags: ["--json", "--limit"], max: 64 },
			{ name: "export", args: "<id>", what: "One chat as Markdown or JSON", flags: ["--format", "--out"], max: 1 },
		],
	},
	{
		name: "sites",
		summary: "Site changes agents saved for you",
		what: "Site changes",
		group: "Sites",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", what: "Every saved site change (live, or the saved copy)", flags: ["--json"] },
			{ name: "off", args: "<id>", what: "Turn one off; only you turn one on, in the side panel", flags: ["--json"], max: 1 },
			{ name: "remove", args: "<id>", what: "Remove one", flags: ["--json"], max: 1 },
		],
	},
	{ name: "tabs", positional: 1, args: "[session]", what: "Every agent tab, by session", group: "Sessions", flags: ["--json"] },
	{
		name: "serve",
		what: "MCP over HTTP on loopback, for tunnels; every request needs a token (--public-url adds OAuth for web connectors)",
		group: "Remote",
		flags: ["--port", "--public-url", "--redirect-host", "--allow-host"],
	},
	{
		name: "token",
		summary: "Scoped, revocable tokens for serve",
		what: "Tokens for serve",
		group: "Remote",
		subcommands: [
			{ name: "create", args: "<name>", what: "A scoped, revocable token, shown once", flags: ["--scope"], max: 1 },
			{ name: "list", what: "Every token and when it was last used", flags: ["--json"] },
			{ name: "revoke", args: "<id|name|client id|grant id>", what: "End a token, an OAuth client and its grants, or one grant", max: 1 },
			{ name: "passcode", what: "A new passcode for the OAuth approval page, shown once", flags: ["--json"] },
			{ name: "approval-code", what: "A one-time code (10 minutes) that approves one connector instead of the passcode", flags: ["--json"] },
			{ name: "clients", what: "OAuth clients (claude.ai, ChatGPT, grok.com) and their grants", flags: ["--json"] },
			{ name: "scopes", what: "The scopes a token can have", flags: ["--json"] },
		],
	},
	{
		name: "hub",
		group: "Remote",
		summary: "One connector URL for many devices; hub token and Funnel-off tunnel",
		what: "Many devices behind one connector URL",
		subcommands: [
			{ name: "setup", what: "Make this always-on box the hub: hub.json, a passcode and a service that runs hub serve", flags: ["--public-url", "--port", "--no-service", "--no-passcode", "--json"] },
			{ name: "serve", what: "Run the hub on loopback (the service runs this)", flags: ["--port", "--public-url"] },
			{ name: "code", what: "A one-time code (10 minutes) that links a device to this hub", flags: ["--name", "--manage", "--json"] },
			{ name: "devices", what: "Devices: online, extension, sessions, busy, last seen", flags: ["--json"] },
			{ name: "remove", args: "<name|id>", what: "Revoke a device's credential and close its link now", max: 1 },
			{ name: "prefer", args: "<name,name,...>", what: "Which device wins a tie when routing a new session", max: 1 },
			{ name: "status", what: "Is the hub up and reachable from the internet?", flags: ["--json"] },
			{ name: "off", what: "Stop the hub service and remove hub.json (devices stay enrolled)" },
			{ name: "token", what: "Create a token scoped to browser.read and browser.navigate", flags: ["--name"] },
			{ name: "tunnel", what: "Open Tailscale serve for hub (Funnel stays off)", flags: ["--port"] },
		],
	},
	{
		name: "link",
		group: "Remote",
		summary: "Put this device behind a hub",
		what: "This device behind a hub",
		subcommands: [
			{ name: "enroll", args: "<hub-url>", what: `Link this device with a code from the hub (${COMMAND_NAME} link <hub-url> works too)`, flags: ["--code", "--name", "--scope", "--no-service", "--json"], max: 1 },
			{ name: "run", what: "Dial the hub and answer its requests (the service runs this)" },
			{ name: "status", what: "Is this device linked and connected?", flags: ["--json"] },
			{ name: "off", what: "Stop the service, forget the hub and revoke the local link token" },
			{ name: "busy", args: "on|off", what: "Mark this device busy: the hub sends new sessions elsewhere first", max: 1 },
			{ name: "scopes", what: "What this device allows; --remove narrows at once, --add widens (never to computer use)", flags: ["--add", "--remove", "--json"] },
			{ name: "code", what: "Ask the hub for a connect code for another device (manager devices only)", flags: ["--manage", "--json"] },
			{ name: "approval-code", what: "Ask the hub for a one-time code to approve an assistant (manager devices only)", flags: ["--json"] },
		],
	},
	{
		name: "theme",
		group: "Remote",
		summary: "Colors of the approval page and hub pages",
		what: "Colors of the approval page and hub pages",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", what: "The presets and the one in use", flags: ["--json"] },
			{ name: "set", args: "<preset>", what: "Use a preset: standard, slate, forest, rose or midnight", flags: ["--json"], max: 1 },
			{ name: "accent", args: "<#rrggbb>", what: "A custom accent color for buttons", flags: ["--json"], max: 1 },
			{ name: "reset", what: "Back to the default theme", flags: ["--json"] },
		],
	},
	{
		name: "remote",
		summary: "One command to reach serve from claude.ai, ChatGPT and grok.com",
		what: "Remote access for web connectors",
		group: "Remote",
		subcommands: [
			{
				name: "setup",
				what: "A relay on your own free Cloudflare account, no domain needed (or Tailscale Funnel with --tailscale, a Cloudflare tunnel with --cloudflare, your tailnet only with --tailnet, or your own --public-url), a passcode and services that keep serve running. Where the Local Studio app is installed, the app runs the tunnel (--cloudflare or --tailnet) and this joins it. In a terminal it asks and waits; --no-wait stops instead",
				flags: ["--relay", "--account", "--cloudflare", "--replace-funnel", "--public-url", "--port", "--no-service", "--no-passcode", "--tailscale", "--tailnet", "--no-wait", "--no-input", "--yes", "--connect-code", "--json"],
				optionalValue: ["--cloudflare", "--relay"],
			},
			{ name: "cloudflare", args: "login", max: 1, what: "Sign in to your own Cloudflare account, in your browser", flags: ["--json"] },
			{ name: "relay", args: "run", max: 1, what: "Run the relay connector in the foreground (the relay service runs this)" },
			{ name: "status", what: "Is it up and reachable from the internet? Fast checks from this computer", flags: ["--json"] },
			{ name: "test", what: "Prove an assistant can reach it, from outside: public DNS, TLS, the OAuth metadata, the sign-in challenge and a streaming probe", flags: ["--json"] },
			{ name: "fix", what: "Repair what remote test or status found, one step at a time, asking first (--yes to skip asking, --dry-run to list)", flags: ["--yes", "--dry-run", "--json"] },
			{ name: "join", what: "Join Local Studio's tunnel: serve on its route record's port and address, stop this install's own tunnel (the tunnel itself stays), prove it, and put everything back on failure", flags: ["--no-service", "--port", "--json"] },
			{ name: "off", what: "Stop the service, close the tunnel or Funnel and remove remote.json", flags: ["--json"] },
			{
				name: "reset",
				what: "After a tunnel token leaked: set the passcode from an owner-only file and end every OAuth grant, client, connect code, hub device credential and static token (a relayed request may have carried one, and which did can't be told; link tokens stay, no public route takes them). Asks first in a terminal; elsewhere and with --json it needs --yes. 0 done and read back, 1 left, 2 refused or not confirmed",
				flags: ["--new-passcode-file", "--yes", "--json"],
			},
		],
	},
	{
		name: "tunnel",
		summary: "Reach serve over Tailscale or Cloudflare",
		what: "Tunnels for serve",
		group: "Remote",
		subcommands: [
			{ name: "tailscale", what: "Reach serve from your tailnet over HTTPS (--public: Funnel)", flags: ["--port", "--public", "--off"] },
			{ name: "cloudflare", what: "A quick tunnel for local testing with a token; claude.ai, ChatGPT and grok.com can't use it (use remote setup)", flags: ["--port", "--off"] },
		],
	},
	{
		name: "library",
		selfParsed: true,
		summary: "Verified sources: add, search, cite, export",
		what: "The source library",
		group: "Library",
		subcommands: [
			{ name: "add", args: "<doi|arxiv>", what: "Save a source, verified against its registry, OpenAlex and retractions", flags: ["--quote", "--location", "--note", "--tag"] },
			{ name: "search", args: "<words>", what: "Find saved sources", flags: ["--json"] },
			{ name: "list", what: "Every saved source", flags: ["--json"] },
			{ name: "cite", args: "<key>", what: "Format a reference", flags: ["--style"] },
			{ name: "export", what: "For Zotero, Word and LaTeX", flags: ["--format", "--out"] },
			{ name: "obsidian", args: "<vault>", what: "One note per source in <vault>/Sources", flags: ["--folder"], paths: true },
			{ name: "verify", args: "[key...]", what: "Re-run the registry and retraction checks" },
			{ name: "remove", args: "<key>", what: "Drop a source from the library" },
		],
	},
	{ name: "allow", positional: 1, args: "<host>", what: "Let agents open a site (subdomains included)", group: "Sites" },
	{ name: "ask", what: "Agents ask before opening a site not yet allowed (default)", group: "Sites" },
	{ name: "allow-all", what: "Agents may open any site without asking", group: "Sites" },
	{ name: "yolo", what: "Old name of allow-all", group: "Sites", hidden: true },
	{ name: "claude-allow", positional: 1, args: "on|off|status", what: "Claude Code uses Local Studio's tools without asking", group: "Sites" },
	{
		name: "vm",
		selfParsed: true,
		summary: "Linux guests on this Mac (Virtualization.framework), reset from a saved ready point",
		what: "Linux guests on this Mac",
		group: "Guests",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", what: "Each guest and whether it runs", flags: ["--json"] },
			{ name: "up", args: "<name>", max: 1, what: "Start a guest: resume its saved session, else boot its disk as it stands (the first boot downloads Debian 13 and saves the ready point; after a reset of a stopped guest, start from that); checks power, RAM, disk and load first", flags: ["--cold", "--from-ready", "--force", "--json"] },
			{ name: "down", args: "<name>", max: 1, what: "Save the guest's session and stop it", flags: ["--json"] },
			{ name: "reset", args: "<name>", max: 1, what: "Back to the ready point; whatever the guest wrote since is gone", flags: ["--json"] },
			{ name: "shot", args: "<name>", max: 1, what: "Save a PNG of the guest's display", flags: ["--out"] },
			{ name: "exec", args: "<name> -- <command>", max: 99, what: "Run a shell command in the guest as root and print its output" },
		],
	},
	{ name: "doctor", what: "Check everything; one fix per problem", group: "Troubleshoot", flags: ["--json"] },
	{
		name: "update",
		selfParsed: true,
		what: "Install the latest signed release",
		group: "Troubleshoot",
		flags: UPDATE_FLAGS,
	},
	{
		name: "install",
		what: "Register the native host with every browser (--browser <name>: one; --remove takes this program's registration back out); --release <folder> checks and installs a downloaded release; --local-studio adds the Local Studio plugins; --dry-run lists what it would write; after --release, services on an older version restart (--no-restart names them instead, --restart-services restarts them later on the installed release, and --dry-run with it only lists them)",
		group: "Troubleshoot",
		flags: ["--force", "--browser", "--remove", "--dry-run", "--local-studio", "--release", "--skip-attestation", "--no-restart", "--restart-services"],
		switches: ["--remove"],
	},
	{ name: "reload", what: "Reload the extension after rebuilding dist-chrome", group: "Troubleshoot", flags: ["--if-idle"] },
	{ name: "debug", what: "Bridge state, request timings and a benchmark (JSON)", group: "Troubleshoot" },
	{ name: "completion", positional: 1, args: "zsh|bash|fish", what: `Completions for ${COMMAND_NAME}: eval "$(${COMMAND_NAME} completion zsh)"`, group: "Troubleshoot", values: ["zsh", "bash", "fish"] },
	{ name: "version", what: "This CLI's version (also --version)", group: "Troubleshoot", flags: ["--json"] },
	{ name: "skill", selfParsed: true, what: "Says where skills went; an older helper's update calls it", group: "Troubleshoot", hidden: true },
	{ name: "help", selfParsed: true, what: "This help (also --help)", group: "Troubleshoot", hidden: true },
	{ name: "host", selfParsed: true, what: "The native host the browser starts", group: "Troubleshoot", hidden: true },
];

export const VISIBLE_COMMANDS = COMMANDS.filter((c) => !c.hidden);

export function commandSpec(name: string): CommandSpec | undefined {
	// --version and -v are the version command.
	const key = name === "--version" || name === "-v" ? "version" : name === "--help" || name === "-h" ? "help" : name;
	return COMMANDS.find((c) => c.name === key);
}

/** "[--json] [--top N]": the flags as help and usage lines show them. */
export function flagHints(flags: string[] = [], switches: string[] = []): string {
	return flags.map((f) => ` [${f}${VALUE_HINTS[f] && !switches.includes(f) ? ` ${VALUE_HINTS[f]}` : ""}]`).join("");
}

/** One help row per command, or per subcommand: [usage after "local-studio-browser ", what it does]. */
export function helpRows(spec: CommandSpec): Array<[string, string]> {
	if (spec.subcommands)
		return spec.subcommands.map((sub) => [`${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}${flagHints(sub.flags)}`, sub.what]);
	return [[`${spec.name}${spec.args ? ` ${spec.args}` : ""}${flagHints(spec.flags, spec.switches)}`, spec.what]];
}

/**
 * Why `args` (everything after the command word) don't fit the command's spec, or undefined when
 * they do: an unknown option, a switch given a value, a value option without its value, or too
 * many arguments. Commands with subcommands are checked against the subcommand's own flags.
 */
export function argsProblem(command: string, args: string[]): string | undefined {
	const spec = commandSpec(command);
	if (!spec || spec.selfParsed) return undefined;
	const name = (a: string) => a.split("=")[0];
	const takesValue = (f: string) => VALUE_FLAGS.has(f) && !spec.switches?.includes(f);
	const positional = args.filter((a, i) => !a.startsWith("-") && !(takesValue(args[i - 1] ?? "") && !args[i - 1].includes("=")));
	let flags = spec.flags ?? [];
	let optional: string[] = [];
	let max = spec.positional ?? 0;
	let usage = `Usage: ${COMMAND_NAME} ${helpRows(spec)[0][0]}`;
	if (spec.subcommands) {
		const sub = spec.subcommands.find((x) => x.name === (positional[0] ?? spec.defaultSubcommand));
		// An unknown or missing subcommand is the command's own usage error, with its list.
		if (!sub) return undefined;
		flags = sub.flags ?? [];
		optional = sub.optionalValue ?? [];
		max = (positional[0] === undefined ? 0 : 1) + (sub.max ?? 0);
		usage = `Usage: ${COMMAND_NAME} ${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}${flagHints(flags)}`;
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("-")) continue;
		if (!flags.includes(name(a))) return `Unknown option "${name(a)}". ${usage}`;
		// A switch takes no value: "--off=1" must not pass here and then go unseen (the dispatcher
		// matches switches exactly).
		if (a.includes("=") && !takesValue(name(a))) return `${name(a)} takes no value. ${usage}`;
		if (takesValue(name(a))) {
			const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
			const missing = value === undefined || value === "" || (!a.includes("=") && value.startsWith("-"));
			// `--cloudflare=` is still refused: an empty value someone typed is a mistake, not a question.
			if (missing && !(optional.includes(name(a)) && !a.includes("="))) return `${name(a)} needs a value. ${usage}`;
		}
	}
	if (positional.length > max) return `Unexpected argument "${positional[max]}". ${usage}`;
	return undefined;
}

/** Exit codes every command uses; also printed by --help. */
export const EXIT_CODES =
	"Exit codes: 0 success, 1 failed, not connected or nothing found, 2 usage error; update --check 100 when an update exists, library add 3 retracted and 4 unchecked, remote setup 3 when a person has to act, remote test 3 when nothing is set up, remote fix 3 when a person has to act or nothing is set up.";

/** `remote --help`, or `remote` alone (a usage error, exit 2): the remote commands in the order a person uses them. */
export const REMOTE_GUIDE = [
	"Remote access for claude.ai, ChatGPT and grok.com, in the order you use it:",
	`  1. ${COMMAND_NAME} remote setup    Make serve reachable: a relay on your Cloudflare account, Tailscale Funnel, a Cloudflare tunnel or your own --public-url`,
	`  2. ${COMMAND_NAME} remote status   Fast checks from this computer: is it up?`,
	`  3. ${COMMAND_NAME} remote test     Prove an assistant can reach and stream from it, from outside`,
	`  4. ${COMMAND_NAME} remote fix      Repair what status or test found (--dry-run lists the steps)`,
	`  5. ${COMMAND_NAME} remote off      Stop the service, close the tunnel and remove remote.json`,
	"Each takes --json. Exit codes: 0 ok, 1 failed, 2 usage; setup and fix also 3 when a person has to act, test and fix 3 when nothing is set up.",
	`Every flag: ${COMMAND_NAME} --help`,
	"",
].join("\n");

function sh(word: string): string {
	return word.replace(/[^A-Za-z0-9_.:,|/-]/g, "");
}

/** Descriptions are quoted for each shell; strip what could end the quote. */
function desc(text: string): string {
	return text.replace(/["'`$\\[\]:]/g, "").replace(/\s+/g, " ");
}

/**
 * Completion scripts. Each offers a command's subcommands, then only the chosen subcommand's
 * flags; where a command or subcommand takes paths (and after --out, --cases, --base, --router)
 * the shell's own file completion runs, so installing these never takes path completion away.
 */
export function completionScript(shell: string): string | undefined {
	const cmds = VISIBLE_COMMANDS;
	const pathFlags = [...PATH_VALUES].map(sh).join(" ");
	if (shell === "zsh") {
		const lines = [
			"#compdef local-studio-browser",
			`# completion for local-studio-browser (zsh). Load it with: eval "$(${COMMAND_NAME} completion zsh)"`,
			"_local_studio() {",
			"  local -a commands subs flags",
			"  local paths=0",
			"  commands=(",
			...cmds.map((c) => `    '${sh(c.name)}:${desc(c.summary ?? c.what)}'`),
			"  )",
			"  if (( CURRENT == 2 )); then",
			"    _describe -t commands 'command' commands",
			"    return",
			"  fi",
			"  case $words[2] in",
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			if (!subs.length && !c.flags?.length && !c.values?.length && !c.paths) continue;
			lines.push(`    ${sh(c.name)})`);
			if (subs.length) {
				lines.push(`      subs=(${subs.map((s) => `'${sh(s.name)}:${desc(s.what)}'`).join(" ")})`);
				lines.push("      case $words[3] in");
				for (const s of subs) {
					if (!s.flags?.length && !s.paths) continue;
					lines.push(`        ${sh(s.name)}) flags=(${(s.flags ?? []).map(sh).join(" ")}); paths=${s.paths ? 1 : 0} ;;`);
				}
				lines.push("      esac");
			} else {
				if (c.values?.length) lines.push(`      subs=(${c.values.map((v) => `'${sh(v)}'`).join(" ")})`);
				lines.push(`      flags=(${(c.flags ?? []).map(sh).join(" ")}); paths=${c.paths ? 1 : 0}`);
			}
			lines.push("      ;;");
		}
		lines.push(
			"  esac",
			"  if (( CURRENT == 3 )) && (( ${#subs} )); then",
			"    _describe -t subcommands 'subcommand' subs",
			"  elif [[ $PREFIX == -* ]]; then",
			"    compadd -- $flags",
			`  elif (( paths )) || [[ " ${pathFlags} " == *" \${words[CURRENT-1]} "* ]]; then`,
			"    _files",
			"  fi",
			"}",
			"# compdef exists once compinit has run. If the zshrc runs it later (oh-my-zsh, zinit,",
			"# prezto), register at the first prompt instead of running compinit a second time.",
			"if (( $+functions[compdef] )); then",
			"  compdef _local_studio local-studio-browser",
			"else",
			"  autoload -Uz add-zsh-hook",
			"  _local_studio_register() {",
			"    (( $+functions[compdef] )) && compdef _local_studio local-studio-browser",
			"    add-zsh-hook -d precmd _local_studio_register",
			"  }",
			"  add-zsh-hook precmd _local_studio_register",
			"fi",
			"",
		);
		return lines.join("\n");
	}
	if (shell === "bash") {
		const valueCases = Object.entries(VALUE_HINTS)
			.filter(([f]) => !PATH_VALUES.has(f))
			.map(([f, hint]) => {
				// A hint like "stable|nightly" lists the values; anything else is free text.
				const values = /^[a-z0-9]+(\|[a-z0-9]+)+$/.test(hint) ? hint.split("|").join(" ") : "";
				return `    ${sh(f)}) ${values ? `COMPREPLY=( $(compgen -W "${values}" -- "$cur") ); ` : ""}compopt +o default 2>/dev/null; return ;;`;
			});
		const lines = [
			`# completion for local-studio-browser (bash). Load it with: eval "$(${COMMAND_NAME} completion bash)"`,
			"_local_studio() {",
			'  local cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}" paths=0',
			"  COMPREPLY=()",
			'  if [ "$COMP_CWORD" -eq 1 ]; then',
			`    COMPREPLY=( $(compgen -W "${cmds.map((c) => sh(c.name)).join(" ")}" -- "$cur") )`,
			"    compopt +o default 2>/dev/null",
			"    return",
			"  fi",
			'  case "$prev" in',
			"    # A path after --out and friends: file completion (-o default).",
			`    ${[...PATH_VALUES].map(sh).join("|")}) return ;;`,
			"    # Any other value: its values when they are a fixed list, never the flags.",
			...valueCases,
			"  esac",
			'  local words=""',
			'  case "${COMP_WORDS[1]}" in',
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			if (subs.length) {
				lines.push(`    ${sh(c.name)})`);
				lines.push(`      if [ "$COMP_CWORD" -eq 2 ]; then words="${subs.map((s) => sh(s.name)).join(" ")}"; else`);
				lines.push('        case "${COMP_WORDS[2]}" in');
				for (const s of subs) if (s.flags?.length || s.paths) lines.push(`          ${sh(s.name)}) words="${(s.flags ?? []).map(sh).join(" ")}"${s.paths ? "; paths=1" : ""} ;;`);
				lines.push("        esac");
				lines.push("      fi ;;");
			} else {
				const all = [...(c.values ?? []), ...(c.flags ?? [])];
				if (all.length || c.paths) lines.push(`    ${sh(c.name)}) words="${all.map(sh).join(" ")}"${c.paths ? "; paths=1" : ""} ;;`);
			}
		}
		lines.push(
			"  esac",
			"  # Where a path goes, a word without a dash completes as a file name, not as a flag.",
			'  if [ "$paths" = 1 ] && [[ "$cur" != -* ]]; then return; fi',
			'  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
			"  # File names only where the command takes a path (compopt needs bash 4; older bash keeps them).",
			'  [ "$paths" = 1 ] || compopt +o default 2>/dev/null',
			"}",
			"complete -o bashdefault -o default -F _local_studio local-studio-browser",
			"",
		);
		return lines.join("\n");
	}
	if (shell === "fish") {
		const lines = [`# completion for local-studio-browser (fish). Load it with: ${COMMAND_NAME} completion fish | source`];
		for (const c of cmds) lines.push(`complete -c local-studio-browser -n __fish_use_subcommand -f -a ${sh(c.name)} -d '${desc(c.summary ?? c.what)}'`);
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			const names = subs.map((s) => sh(s.name)).join(" ");
			for (const s of subs) {
				lines.push(`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}; and not __fish_seen_subcommand_from ${names}' -f -a ${sh(s.name)} -d '${desc(s.what)}'`);
				for (const f of s.flags ?? [])
					lines.push(
						`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}; and __fish_seen_subcommand_from ${sh(s.name)}' -l ${sh(f.replace(/^--/, ""))}${VALUE_FLAGS.has(f) ? (PATH_VALUES.has(f) ? " -r -F" : " -r") : ""}`,
					);
			}
			for (const s of subs)
				if (!s.paths) lines.push(`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}; and __fish_seen_subcommand_from ${sh(s.name)}' -f`);
			// No file names where a command takes none.
			if (!subs.length && !c.paths) lines.push(`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}' -f`);
			for (const v of c.values ?? []) lines.push(`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}' -f -a ${sh(v)}`);
			for (const f of c.flags ?? [])
				lines.push(`complete -c local-studio-browser -n '__fish_seen_subcommand_from ${sh(c.name)}' -l ${sh(f.replace(/^--/, ""))}${VALUE_FLAGS.has(f) && !c.switches?.includes(f) ? " -r" : ""}`);
		}
		lines.push("");
		return lines.join("\n");
	}
	return undefined;
}
