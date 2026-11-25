/**
 * Linux abstract sockets, as Eukhe names its daemon's (eukhe-types platform/transport.rs, 0.10.74 and up): the socket
 * file's path as the name, no file. Any user may bind a free abstract name first, so before a byte is sent the listener
 * must be the process Eukhe recorded beside the path (`<path>.pid`), running as this user. Node can't read a socket's peer
 * credentials; the kernel's own list (/proc/net/unix) and that process's open files say the same.
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

/** The longest name: `sun_path` less the leading NUL. */
const MAX_NAME = 107;
/** /proc/net/unix flags of a listening socket (SO_ACCEPTCON). */
const LISTENING = "00010000";

/** The address Node's `connect` takes for `path`'s abstract socket. */
export function abstractAddress(path: string): string | undefined {
	return Buffer.byteLength(path) <= MAX_NAME ? `\0${path}` : undefined;
}

/** The inode of the socket listening at `@path`, from /proc/net/unix's text. */
export function listeningInode(table: string, path: string): string | undefined {
	for (const line of table.split("\n")) {
		// Num RefCount Protocol Flags Type St Inode Path
		const m = /^\S+ \S+ \S+ (\S+) \S+ \S+ +(\d+) (.*)$/.exec(line);
		if (m && m[1] === LISTENING && m[3] === `@${path}`) return m[2];
	}
	return undefined;
}

/** Whether something listens at `@path`; false off Linux. */
export function abstractListens(path: string): boolean {
	if (process.platform !== "linux") return false;
	try {
		return listeningInode(readFileSync("/proc/net/unix", "utf8"), path) !== undefined;
	} catch {
		return false;
	}
}

/** Why the listener at `@path` can't be trusted, or undefined. */
export function untrustedListener(path: string, uid: number = process.getuid?.() ?? 0): string | undefined {
	const record = `${path}.pid`;
	let pid: string;
	try {
		const stat = lstatSync(record);
		if (!stat.isFile() || stat.uid !== uid) return `its pid file ${record} is not this user's`;
		pid = readFileSync(record, "utf8").trim();
	} catch {
		return `no Eukhe process is recorded in ${record}`;
	}
	if (!/^[1-9]\d{0,9}$/.test(pid)) return `no Eukhe process is recorded in ${record}`;
	try {
		if (lstatSync(`/proc/${pid}`).uid !== uid) return `it is served by another user's process (${pid})`;
		const inode = listeningInode(readFileSync("/proc/net/unix", "utf8"), path);
		if (inode === undefined) return "nothing listens there";
		for (const fd of readdirSync(`/proc/${pid}/fd`)) {
			try {
				if (readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return undefined;
			} catch {
				/* closed meanwhile */
			}
		}
	} catch {
		return `the Eukhe process recorded for it (${pid}) is gone`;
	}
	return `it is not served by the Eukhe process recorded for it (${pid})`;
}
