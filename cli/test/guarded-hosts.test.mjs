// Issue #94, host side: which hostnames the native host tells the extension an agent may not open.
// Every config dir is a temp dir; nothing here touches ~/.local-studio/browser.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { rmSync, tempRoot } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = tempRoot("local-studio-guarded-");
after(() => rmSync(root, { recursive: true, force: true }));
const { guardedHosts, isGuardedUrl } = await loadTs(`
	export { guardedHosts } from "@src/guarded-hosts.ts";
	export { isGuardedUrl } from "@src/../../src/bridge/permissions.ts";
`);

const loopbackOf = (...ports) => ports.flatMap((p) => ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${p}`));
const publicOnly = (hosts) => hosts.filter((h) => !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h));

function inConfig(name, files) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
	const before = process.env.LOCAL_STUDIO_BROWSER_DIR;
	process.env.LOCAL_STUDIO_BROWSER_DIR = dir;
	try {
		return guardedHosts();
	} finally {
		if (before === undefined) delete process.env.LOCAL_STUDIO_BROWSER_DIR;
		else process.env.LOCAL_STUDIO_BROWSER_DIR = before;
	}
}

test("no remote, hub or link config guards nothing", () => {
	assert.deepEqual(inConfig("none", {}), loopbackOf(8787), "only the default serve port on loopback");
});

test("the public URL of remote.json and hub.json, and the hub a device linked to, are guarded", () => {
	assert.deepEqual(publicOnly(inConfig("remote", { "remote.json": { publicUrl: "https://Box.Example.ts.net:8443", port: 8787, route: "funnel" } })), ["box.example.ts.net"]);
	assert.deepEqual(publicOnly(inConfig("hub", { "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } })), ["hub.example.com"]);
	assert.deepEqual(publicOnly(inConfig("link", { "link.json": { hubUrl: "https://hub.example.com", deviceId: "d1", secret: "s", name: "laptop" } })), ["hub.example.com"]);
	const all = publicOnly(inConfig("all", {
		"remote.json": { publicUrl: "https://a.example.com", port: 1, route: "custom" },
		"hub.json": { publicUrl: "https://b.example.com", port: 2 },
		"link.json": { hubUrl: "https://b.example.com", deviceId: "d1", secret: "s", name: "laptop" },
	}));
	assert.deepEqual(all.sort(), ["a.example.com", "b.example.com"], "deduplicated");
});

test("a broken config file adds nothing and does not stop the others", () => {
	assert.deepEqual(publicOnly(inConfig("broken", { "remote.json": "{not json", "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } })), ["hub.example.com"]);
});

test("the aliases of remote.json are guarded beside its public URL, by the same rule", () => {
	const remote = { publicUrl: "https://new.example.com", port: 8787, route: "custom", aliases: ["old.example.com", "older.example.com"] };
	const hosts = inConfig("aliases", { "remote.json": remote });
	assert.deepEqual(publicOnly(hosts), ["new.example.com", "old.example.com", "older.example.com"]);
	for (const name of ["new.example.com", "old.example.com"]) {
		assert.equal(isGuardedUrl(`https://${name}/authorize`, hosts), true, name);
		assert.equal(isGuardedUrl(`https://sub.${name}/authorize`, hosts), false, `a subdomain of ${name} is another host`);
	}
	assert.deepEqual(publicOnly(inConfig("no-aliases", { "remote.json": { ...remote, aliases: undefined } })), ["new.example.com"]);
});

test("a bad alias entry or a bad aliases field leaves the rest guarded", () => {
	const remote = { publicUrl: "https://new.example.com", port: 9001, route: "custom" };
	for (const [i, aliases] of [[7, null, "", "a b", "old.example.com"], "old.example.com", { 0: "old.example.com" }, null].entries()) {
		const hosts = inConfig(`bad-alias-${i}`, { "remote.json": { ...remote, aliases } });
		assert.deepEqual(publicOnly(hosts), i === 0 ? ["new.example.com", "old.example.com"] : ["new.example.com"]);
		assert.ok(hosts.includes("localhost:9001"));
	}
});

test("loopback aliases of the serve and hub ports are guarded as host:port, and nothing else local", () => {
	const hosts = inConfig("ports", {
		"remote.json": { publicUrl: "https://a.example.com", port: 9001, route: "custom" },
		"hub.json": { publicUrl: "https://b.example.com", port: 9002 },
	});
	for (const entry of loopbackOf(8787, 9001, 9002)) assert.ok(hosts.includes(entry), `${entry} is guarded`);
	assert.equal(hosts.some((h) => h === "localhost" || h === "127.0.0.1"), false, "no bare loopback host: other ports stay open");
});
