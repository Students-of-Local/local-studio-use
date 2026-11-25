/**
 * `remote reset --new-passcode-file <path>`: after a tunnel token leaked (someone ran a second connector with it, so some
 * `/authorize` submissions, which carry the passcode, reached them), rotate the owner passcode and end everything an
 * assistant could still use, before the tunnel comes back:
 *
 * - the passcode, read from a file only the owner can read (never argv, never the environment), set the way `token passcode`
 *   sets one;
 * - every OAuth grant (access and refresh tokens) and every client registration, and the signing key, which ends approval
 *   forms and authorization codes issued before (codes live in serve's memory, bound to the key);
 * - every waiting connect code: approval codes, and a hub's device codes;
 * - every hub device credential, when this folder holds a hub: a manager device sends its credential over the same tunnel, and
 *   Local Studio can't tell which crossed it. A running hub closes their links within a second; each device links again;
 * - every static `tkr_` token but link tokens. A static token never passes through `/authorize`, so the passcode leak doesn't
 *   reach it, but any `/mcp` request relayed through the second connector carried its bearer token, and Local Studio can't tell
 *   which tokens were used through the tunnel. A link token is refused on any serve with a public route, so none that works
 *   ever went through one; they stay, so a hub link keeps working.
 *
 * Each step runs even when one before it failed, then a fresh read of every file proves the result. Exit 0 only when every
 * step is done and read back; 1 when a step or the read-back failed (the report names what is left); 2 when the passcode file
 * or the config folder is refused, or the reset isn't confirmed, before anything changes.
 *
 * An agent can run it for a person: it asks only at a terminal, and never with --json. Without a terminal (or with --json) it
 * needs --yes, else it refuses with code `confirmation_required`. Every result names the state and, when there is one, the
 * next command to run (`next`), as `remote fix` does.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultConfigDir } from "./files.ts";
import { clearConnectCodes, devicesFile, devicesReadable, hubFile, liveConnectCodes, loadDevices, loadHubConfig, removeAllDevices } from "./hub-state.ts";
import { clearApprovalCodes, configDir, liveApprovalCodes, oauthCounts, passcodeMatches, passcodeProblem, resetOAuth } from "./oauth.ts";
import { loadTokens, revokeStaticTokens, tokenLive } from "./remote.ts";
import { askYes, closeInput, interactiveTerminal } from "./remote-guide.ts";
import { printReport } from "./remote-state.ts";
import { COMMAND_NAME } from "./self.ts";
import { HUB_SERVICE, SERVE_SERVICE, savedFolders, serviceFile } from "./service.ts";
import { sym } from "./ui.ts";

export const EXIT_RESET_DONE = 0;
export const EXIT_RESET_FAILED = 1;
export const EXIT_RESET_REFUSED = 2;

/** A passcode file this big is not a passcode. */
const MAX_FILE_BYTES = 4096;

/** A refused passcode file; `fix` is the command that fixes it, when one does. */
export class PasscodeFileError extends Error {
	constructor(
		message: string,
		readonly fix?: string,
	) {
		super(message);
	}
}

/** Quoted for a POSIX shell. */
const shellQuote = (text: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

/**
 * The passcode in `path`. Refused: a link, anything but a regular file, a file group or others can read or write, one that
 * belongs to another account, an empty one, and a passcode `token passcode`'s rules refuse (passcodeProblem). One trailing
 * newline is dropped. On Windows the permission and owner checks are skipped: NTFS access lists aren't in the mode bits.
 */
export function readPasscodeFile(path: string): string {
	const shown = resolve(path);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new PasscodeFileError(`${shown} doesn't exist.`);
		if (code === "ELOOP" || code === "EMLINK") throw new PasscodeFileError(`${shown} is a symbolic link. Give the file itself.`);
		throw new PasscodeFileError(`${shown} can't be opened (${code ?? (err as Error).message}).`);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new PasscodeFileError(`${shown} isn't a regular file.`);
		if (process.platform !== "win32") {
			if (st.mode & 0o077) throw new PasscodeFileError(`${shown} can be read or written by others (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}). Make it the owner's alone: chmod 600 ${shellQuote(shown)}`, `chmod 600 ${shellQuote(shown)}`);
			if (process.getuid && st.uid !== process.getuid()) throw new PasscodeFileError(`${shown} belongs to another account.`);
		}
		if (st.size > MAX_FILE_BYTES) throw new PasscodeFileError(`${shown} is ${st.size} bytes; a passcode file holds one line.`);
		const passcode = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
		const problem = passcodeProblem(passcode);
		if (problem) throw new PasscodeFileError(`The passcode in ${shown} can't be used: ${problem}.`);
		return passcode;
	} finally {
		closeSync(fd);
	}
}

/**
 * A serve or hub service set up with its own config folder reads its grants there, and one set up with none reads the default
 * folder, whatever this shell's LOCAL_STUDIO_BROWSER_DIR says. A reset of another folder would leave them all working, so it is
 * refused, naming the folder to run it in.
 */
function otherConfigFolder(): string | undefined {
	const here = resolve(configDir());
	for (const spec of [SERVE_SERVICE, HUB_SERVICE]) {
		const file = serviceFile(spec);
		if (!file || !existsSync(file)) continue;
		const folder = savedFolders(spec).config ?? defaultConfigDir();
		if (resolve(folder) !== here) return folder;
	}
	return undefined;
}

export interface ResetOptions {
	passcodeFile: string | undefined;
	json: boolean;
	/** Reset without asking: needed without a terminal, and with --json. */
	yes: boolean;
}

/** What to do next, for an agent: the shape `remote fix` reports. `relink` names each hub device to link again, with the command that makes its code. */
type Next = { kind: "run_command"; command: string; message?: string; relink?: { device: string; command: string }[] };

/** How many of each the reset ended. */
interface Ended {
	clients: number;
	grants: number;
	approvalCodes: number;
	deviceCodes: number;
	staticRevoked: number;
	devices: { id: string; name: string; manage: boolean }[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function remoteReset(options: ResetOptions): Promise<number> {
	const say = (line: string) => {
		if (!options.json) console.log(line);
	};
	const refuse = (code: string, message: string, next?: Next) => {
		if (options.json) printReport({ ok: false, state: "refused", code, message: `${message} Nothing was changed.`, ...(next ? { next } : {}) });
		else console.error(`${sym.fail} ${message} Nothing was changed.`);
		return EXIT_RESET_REFUSED;
	};
	if (!options.passcodeFile) return refuse("usage", `Usage: ${COMMAND_NAME} remote reset --new-passcode-file <path> [--yes] [--json]`);
	// The command again, as given, for a `next` step: the file path is a path, never the passcode.
	const again = (env = "", yes = options.yes) => `${env}${COMMAND_NAME} remote reset --new-passcode-file ${shellQuote(resolve(options.passcodeFile ?? ""))}${yes ? " --yes" : ""}${options.json ? " --json" : ""}`;
	let passcode: string;
	try {
		passcode = readPasscodeFile(options.passcodeFile);
	} catch (err) {
		if (err instanceof PasscodeFileError) return refuse("passcode_file", err.message, err.fix ? { kind: "run_command", command: err.fix } : undefined);
		throw err;
	}
	const other = otherConfigFolder();
	if (other) {
		const command = again(`LOCAL_STUDIO_BROWSER_DIR=${shellQuote(other)} `);
		return refuse("config_folder", `The service reads ${other}, and this shell uses ${configDir()}. Run it there: ${command}`, { kind: "run_command", command });
	}
	if (!options.yes) {
		// Never a question without a terminal, or in a JSON run an agent reads: --yes says the person asked for this reset.
		if (options.json || !interactiveTerminal()) {
			return refuse("confirmation_required", `remote reset ends every assistant's connection and needs a yes. Run it in a terminal, or add --yes: ${again("", true)}`, { kind: "run_command", command: again("", true) });
		}
		const sure = await askYes(`Replace the passcode and end every OAuth grant, client registration, connect code and static token in ${configDir()}? Every assistant must connect again. [y/N] `);
		closeInput();
		if (!sure) return refuse("declined", "Stopped: you said no.");
	}

	const ended: Ended = { clients: 0, grants: 0, approvalCodes: 0, deviceCodes: 0, staticRevoked: 0, devices: [] };
	const failed: { step: string; detail: string }[] = [];
	const step = (name: string, fn: () => void) => {
		try {
			fn();
		} catch (err) {
			failed.push({ step: name, detail: err instanceof Error ? err.message : String(err) });
		}
	};
	step("oauth", () => {
		const r = resetOAuth(passcode);
		ended.clients = r.clients;
		ended.grants = r.grants;
	});
	step("approval_codes", () => {
		ended.approvalCodes = clearApprovalCodes();
	});
	step("device_codes", () => {
		ended.deviceCodes = clearConnectCodes();
	});
	step("static_tokens", () => {
		ended.staticRevoked = revokeStaticTokens();
	});
	step("hub_devices", () => {
		ended.devices = removeAllDevices().map((d) => ({ id: d.id, name: d.name, manage: d.manage }));
	});

	// The read-back: a fresh read of every file, whatever the steps reported.
	const left: { name: string; detail: string }[] = [];
	const check = (name: string, fn: () => string | undefined) => {
		try {
			const detail = fn();
			if (detail) left.push({ name, detail });
		} catch (err) {
			left.push({ name, detail: `couldn't be read back: ${err instanceof Error ? err.message : String(err)}` });
		}
	};
	check("passcode", () => (passcodeMatches(passcode) ? undefined : "the stored passcode isn't the new one"));
	check("oauth", () => {
		const c = oauthCounts();
		return c.clients || c.tokens ? `oauth.json still holds ${plural(c.clients, "client")} and ${plural(c.tokens, "token")}` : undefined;
	});
	check("approval_codes", () => {
		const n = liveApprovalCodes();
		return n ? `${plural(n, "approval code")} still live` : undefined;
	});
	check("device_codes", () => {
		const n = liveConnectCodes();
		return n ? `${plural(n, "device connect code")} still live` : undefined;
	});
	let linkKept = 0;
	check("static_tokens", () => {
		const live = loadTokens().filter((t) => tokenLive(t));
		linkKept = live.filter((t) => t.kind === "link").length;
		const still = live.filter((t) => t.kind !== "link");
		return still.length ? `${plural(still.length, "static token")} still live: ${still.map((t) => t.id).join(", ")}` : undefined;
	});
	check("hub_devices", () => {
		if (!existsSync(hubFile()) && !existsSync(devicesFile())) return undefined;
		// A file the hub can't read keeps its links open (it is not a revocation), so it isn't proof either.
		if (!devicesReadable()) return `${devicesFile()} can't be read, and a running hub keeps its links while it can't`;
		const still = loadDevices().devices;
		return still.length ? `${plural(still.length, "hub device")} still enrolled: ${still.map((d) => d.name).join(", ")}` : undefined;
	});

	const ok = failed.length === 0 && left.length === 0;
	// Done: each assistant connects again with a one-time approval code. Not done: the same reset again, which is safe to repeat.
	const next: Next = ok ? { kind: "run_command", command: `${COMMAND_NAME} token approval-code${options.json ? " --json" : ""}` } : { kind: "run_command", command: again("", true) };
	if (ok && ended.devices.length) {
		let hubUrl = "<hub url>";
		try {
			hubUrl = loadHubConfig()?.publicUrl ?? hubUrl;
		} catch {
			/* the hub's file is wrong: the person knows its address */
		}
		next.relink = ended.devices.map((d) => ({ device: d.name, command: `${COMMAND_NAME} hub code --name ${shellQuote(d.name)}${d.manage ? " --manage" : ""}` }));
		next.message = `Link each removed device again: run its command here, then on that device ${COMMAND_NAME} link ${hubUrl} --code <code>.`;
	}
	const message = ok
		? `The passcode is replaced, and every grant, client registration, connect code${ended.devices.length ? ", hub device" : ""} and static token is ended and read back. Every assistant must connect again with a new connect code${ended.devices.length ? ", and every device must link again" : ""}.`
		: `Reset isn't complete: ${[...failed.map((f) => `${f.step} failed (${f.detail})`), ...left.map((l) => `${l.name}: ${l.detail}`)].join("; ")}. Run ${COMMAND_NAME} remote reset again before the tunnel comes back.`;
	if (options.json) {
		printReport({ ok, state: ok ? "done" : "failed", message, ended, kept: { linkTokens: linkKept }, failed, left, next });
		return ok ? EXIT_RESET_DONE : EXIT_RESET_FAILED;
	}
	if (!failed.some((f) => f.step === "oauth")) {
		say(`${sym.ok} New passcode set from the file.`);
		say(`${sym.ok} Ended ${plural(ended.grants, "OAuth grant")} and ${plural(ended.clients, "client registration")}.`);
	}
	if (!failed.some((f) => f.step === "approval_codes" || f.step === "device_codes")) say(`${sym.ok} Ended ${plural(ended.approvalCodes + ended.deviceCodes, "waiting connect code")}.`);
	if (!failed.some((f) => f.step === "static_tokens")) say(`${sym.ok} Revoked ${plural(ended.staticRevoked, "static token")}${linkKept ? `; kept ${plural(linkKept, "link token")}, which no public route accepts` : ""}.`);
	if (!failed.some((f) => f.step === "hub_devices") && ended.devices.length) say(`${sym.ok} Removed ${plural(ended.devices.length, "hub device")}: ${ended.devices.map((d) => d.name).join(", ")}. A running hub closes their links within a second.`);
	if (ok) {
		say(`${sym.ok} ${message} A running serve refuses the old tokens at once and closes their sessions within a second.`);
		say(`  Connect each assistant again: ${next.command}`);
		if (next.relink) {
			say(`  ${next.message}`);
			for (const r of next.relink) say(`    ${r.device}: ${r.command}`);
		}
	} else console.error(`${sym.fail} ${message}`);
	return ok ? EXIT_RESET_DONE : EXIT_RESET_FAILED;
}
