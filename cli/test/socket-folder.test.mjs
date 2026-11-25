// A host listens only in its own socket folder, /tmp/local-studio-browser-<user>, and a client connects only there.
import extensionId from "../../src/bridge/extension-id.json" with { type: "json" };
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";
const EXTENSION_ID = extensionId.id;

const posix = process.platform !== "win32";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("a host listens in its own folder and takes its socket away when it stops", { skip: !posix && "pipes on Windows", timeout: 30_000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "socket-dirs-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
	delete env.LOCAL_STUDIO_BROWSER_SOCKET_DIR;
	const host = spawn(process.execPath, [cli, "host", `chrome-extension://${EXTENSION_ID}/`], { env, stdio: ["pipe", "ignore", "pipe"] });
	t.after(() => host.kill("SIGKILL"));
	const user = userInfo().username;
	const own = `/tmp/local-studio-browser-${user}/${host.pid}.sock`;
	for (let i = 0; i < 200 && !existsSync(own); i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(existsSync(own), "the host listens in its own folder");
	await new Promise((resolve, reject) => {
		const sock = connect(own, () => {
			sock.destroy();
			resolve();
		});
		sock.on("error", reject);
	});
	const exited = new Promise((r) => host.once("exit", r));
	host.stdin.end();
	await exited;
	assert.equal(existsSync(own), false, "the socket is gone when the host stops");
});

/** A folder with a 0700 and a 0755 directory, a file, a link to each, a link to nothing, and a link to the folder itself. */
function folders(t) {
	const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "sd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const at = (name) => join(root, name);
	mkdirSync(at("own"), { mode: 0o700 });
	mkdirSync(at("wide"));
	chmodSync(at("wide"), 0o755);
	writeFileSync(at("file"), "");
	chmodSync(at("file"), 0o644);
	for (const name of ["own", "wide", "gone"]) symlinkSync(at(name), at(`to-${name}`));
	symlinkSync(root, at("parent"));
	return { at, mode: (name) => statSync(at(name)).mode & 0o777 };
}

test("a client takes the socket folder only when it is its own closed directory, not a link to one", { skip: !posix && "pipes on Windows" }, async (t) => {
	const { assertSecurePath } = await loadTs(`export { assertSecurePath } from "@src/paths.ts";`);
	const { at } = folders(t);
	assertSecurePath(at("own"), "dir");
	assertSecurePath(join(at("parent"), "own"), "dir"); // a link among the parents, as macOS's /tmp is
	assert.throws(() => assertSecurePath(at("to-own"), "dir"), /to-own is a symlink/);
	assert.throws(() => assertSecurePath(`${at("to-own")}/`, "dir"), /is a symlink/);
	assert.throws(() => assertSecurePath(at("wide"), "dir"), /mode 755, expected 700/);
	assert.throws(() => assertSecurePath(at("file"), "dir"), /is not a directory/);
	assert.throws(() => assertSecurePath(at("none"), "dir"), /ENOENT/);
	if (process.getuid() !== 0) assert.throws(() => assertSecurePath("/", "dir"), /owned by another user/);
});

test("a host starts only in its own real folder, and changes no other folder's mode", { skip: !posix && "pipes on Windows", timeout: 60_000 }, async (t) => {
	const { at, mode } = folders(t);
	const start = (dir) => {
		const env = { ...process.env, HOME: at("home"), XDG_CONFIG_HOME: at("config"), XDG_DATA_HOME: at("data"), XDG_STATE_HOME: at("state"), XDG_CACHE_HOME: at("cache"), LOCAL_STUDIO_BROWSER_SOCKET_DIR: dir };
		const host = spawn(process.execPath, [cli, "host", `chrome-extension://${EXTENSION_ID}/`], { env, stdio: ["pipe", "ignore", "pipe"] });
		t.after(() => host.kill("SIGKILL"));
		host.stderr.setEncoding("utf8").on("data", (d) => {
			host.said = (host.said ?? "") + d;
		});
		host.ended = new Promise((r) => host.once("close", r));
		return host;
	};
	for (const [name, why] of [["to-own", /is a symlink; refusing/], ["to-wide", /is a symlink; refusing/], ["to-gone", /is a symlink; refusing/], ["file", /is not a directory; refusing/]]) {
		const host = start(at(name));
		assert.equal(await host.ended, 1, name);
		assert.match(host.said, why, name);
	}
	assert.equal(mode("wide"), 0o755, "the link's target keeps its mode");
	assert.equal(mode("file"), 0o644);
	for (const dir of [at("fresh"), at("own"), join(at("parent"), "own2")]) {
		const host = start(dir);
		for (let i = 0; i < 200 && !existsSync(join(dir, `${host.pid}.sock`)); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(existsSync(join(dir, `${host.pid}.sock`)), `${dir}: ${host.said ?? ""}`);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		host.stdin.end();
		await host.ended;
	}
});
