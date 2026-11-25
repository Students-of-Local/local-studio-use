// Where hosts listen and clients look. Local Studio has its own folder, /tmp/local-studio-browser-<user>; listSockets can still search
// several folders (an override names one), newest host first.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSockets } from "../cli/src/client.ts";
import { socketDir, socketDirs } from "../cli/src/paths.ts";

const posix = process.platform !== "win32";

test("clients find a live host in a second folder, newest first across both", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "first");
	const old = join(root, "second");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
	}
	// listSockets keeps names whose pid is alive; this process and its parent are.
	const oldSock = join(old, `${process.pid}.sock`);
	writeFileSync(oldSock, "");
	assert.deepEqual(listSockets([fresh, old]), [oldSock], "a host only in the old folder is found");
	const newSock = join(fresh, `${process.ppid}.sock`);
	writeFileSync(newSock, "");
	const past = new Date(Date.now() - 60_000);
	utimesSync(oldSock, past, past);
	assert.deepEqual(listSockets([fresh, old]), [newSock, oldSock]);
	// An old folder anyone could have planted is skipped, not trusted.
	chmodSync(old, 0o755);
	assert.deepEqual(listSockets([fresh, old]), [newSock]);
	chmodSync(fresh, 0o755);
	assert.throws(() => listSockets([fresh, old]), /mode 755/, "the current folder still has to be private");
});

test("a host in both folders is listed once, from the new one", { skip: !posix && "pipes on Windows" }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "socket-dirs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fresh = join(root, "first");
	const old = join(root, "second");
	for (const dir of [fresh, old]) {
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, `${process.pid}.sock`), "");
	}
	assert.deepEqual(listSockets([fresh, old]), [join(fresh, `${process.pid}.sock`)]);
});

test("the socket folder is /tmp/local-studio-browser-<user>, or the override", { skip: !posix && "pipes on Windows" }, () => {
	const saved = process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
	delete process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
	try {
		const user = userInfo().username;
		assert.deepEqual(socketDirs(), [`/tmp/local-studio-browser-${user}`]);
		assert.equal(socketDir(), `/tmp/local-studio-browser-${user}`);
		process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR = "/x/override";
		assert.deepEqual(socketDirs(), ["/x/override"]);
	} finally {
		if (saved === undefined) delete process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
		else process.env.LOCAL_STUDIO_BROWSER_SOCKET_DIR = saved;
	}
});
