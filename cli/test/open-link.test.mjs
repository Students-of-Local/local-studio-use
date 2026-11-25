// The native host's side of links (cli/src/open-link.ts): which program starts with which arguments on each system, and what
// never opens. The grammar's own cases are in the extension's test/links.test.mjs.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { answerOpen, openLink, PANES } = await loadTs(`
export { answerOpen, openLink } from "@src/open-link.ts";
export { PANES } from "@src/../../src/links/parse.ts";`);

function seam(t, platform, extra = {}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "links-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const started = [];
	return { platform, home, env: { PATH: join(home, "bin") }, started, start: async (program, args, options) => void started.push([program, ...args, ...(options?.verbatim ? ["verbatim"] : [])]), ...extra };
}
const program = (s, name) => {
	mkdirSync(join(s.home, "bin"), { recursive: true });
	writeFileSync(join(s.home, "bin", name), "#!/bin/sh\n");
	chmodSync(join(s.home, "bin", name), 0o755);
};

test("the computer's settings open on each system by a fixed command", async (t) => {
	const mac = seam(t, "darwin");
	assert.equal(await openLink("localstudio://system/displays", mac), "Opened Displays settings.");
	assert.deepEqual(mac.started, [["/usr/bin/open", "x-apple.systempreferences:com.apple.Displays-Settings.extension"]]);
	for (const pane of Object.keys(PANES)) await openLink(`localstudio://system/${pane}`, mac);
	assert.ok(mac.started.every(([p, arg]) => p === "/usr/bin/open" && /^x-apple\.systempreferences:com\.apple\.[\w.-]+(\?Privacy_\w+)?$/.test(arg)));
	const win = seam(t, "win32");
	await openLink("localstudio://system/displays", win);
	assert.deepEqual(win.started, [["explorer.exe", "ms-settings:display"]]);
	await assert.rejects(openLink("localstudio://system/screen-time", win), /no Screen Time settings/);
	const linux = seam(t, "linux");
	await assert.rejects(openLink("localstudio://system/displays", linux), /no settings program/);
	program(linux, "systemsettings");
	await openLink("localstudio://system/displays", linux);
	program(linux, "gnome-control-center");
	await openLink("localstudio://system/displays", linux);
	assert.deepEqual(linux.started, [["systemsettings", "kcm_kscreen"], ["gnome-control-center", "display"]]);
});

test("an app opens by name alone, with no arguments of the link's", async (t) => {
	const mac = seam(t, "darwin");
	assert.equal(await openLink("localstudio://app/Visual%20Studio%20Code", mac), "Opened Visual Studio Code.");
	assert.deepEqual(mac.started, [["/usr/bin/open", "-a", "Visual Studio Code"]]);
	const none = seam(t, "darwin", { start: async () => Promise.reject(new Error("Unable to find application")) });
	await assert.rejects(openLink("localstudio://app/Nope", none), /no app called Nope on this Mac/);
	const linux = seam(t, "linux");
	const apps = join(linux.home, ".local", "share", "applications");
	mkdirSync(apps, { recursive: true });
	linux.env.XDG_DATA_DIRS = join(linux.home, "none");
	writeFileSync(join(apps, "org.gnome.Calculator.desktop"), "[Desktop Entry]\nName=Calculator\nExec=gnome-calculator\n\n[Desktop Action x]\nName=New window\n");
	writeFileSync(join(apps, "hidden.desktop"), "[Desktop Entry]\nName=Hidden\nNoDisplay=true\nExec=x\n");
	writeFileSync(join(apps, "-bad.desktop"), "[Desktop Entry]\nName=Bad\n");
	await openLink("localstudio://app/calculator", linux);
	assert.deepEqual(linux.started, [["gtk-launch", "org.gnome.Calculator"]]);
	for (const name of ["Hidden", "Bad", "New%20window"]) await assert.rejects(openLink(`localstudio://app/${name}`, linux), /no app called/);
	await assert.rejects(openLink("localstudio://app/Calculator", seam(t, "win32")), /Windows/);
});

test("documents and plain folders open; programs, bundles and what is missing do not", async (t) => {
	const s = seam(t, "darwin");
	const at = (name) => join(s.home, name);
	const link = (name) => `localstudio://file?path=${encodeURIComponent(at(name))}`;
	for (const name of ["report.pdf", "run.command", "run.sh", "page.html", "pic.svg", "place.webloc", "tool", "x.app.pdf"]) writeFileSync(at(name), "x");
	mkdirSync(at("folder"));
	mkdirSync(at("Evil.app"));
	mkdirSync(at("bundle.pdf"));
	symlinkSync(at("run.command"), at("looks.pdf"));
	symlinkSync(at("Evil.app"), at("plain"));
	symlinkSync(at("report.pdf"), at("alias"));
	for (const [name, opens] of [["report.pdf", "report.pdf"], ["folder", "folder"], ["alias", "report.pdf"]]) {
		assert.equal(await openLink(link(name), s), `Opened ${opens}.`);
		assert.deepEqual(s.started.at(-1), ["/usr/bin/open", at(opens)]);
	}
	await openLink("localstudio://file?path=~/report.pdf", s);
	assert.deepEqual(s.started.at(-1), ["/usr/bin/open", at("report.pdf")]);
	const n = s.started.length;
	for (const name of ["run.command", "run.sh", "page.html", "pic.svg", "place.webloc", "tool", "Evil.app", "bundle.pdf", "looks.pdf", "plain"])
		await assert.rejects(openLink(link(name), s), /doesn't open from a link/, name);
	await assert.rejects(openLink(link("gone.pdf"), s), /isn't there/);
	await assert.rejects(openLink("localstudio://file?path=C:%5Ca.pdf", s), /not a path on this computer/);
	assert.equal(s.started.length, n);
	assert.equal(await openLink(`localstudio://reveal?path=${encodeURIComponent(at("run.command"))}`, s), "Showing run.command.");
	assert.deepEqual(s.started.at(-1), ["/usr/bin/open", "-R", at("run.command")]);
	const linux = { ...s, platform: "linux" };
	await openLink(link("report.pdf"), linux);
	await openLink(`localstudio://reveal?path=${encodeURIComponent(at("report.pdf"))}`, linux);
	assert.deepEqual(s.started.slice(-2), [["xdg-open", at("report.pdf")], ["xdg-open", s.home]]);
});

test("a shortcut runs on a Mac only", async (t) => {
	const mac = seam(t, "darwin");
	await openLink("localstudio://shortcut/Focus%20time", mac);
	assert.deepEqual(mac.started, [["/usr/bin/shortcuts", "run", "Focus time"]]);
	await assert.rejects(openLink("localstudio://shortcut/Focus", seam(t, "linux")), /Mac feature/);
});

test("a frame is exactly type, id and link; the rest is refused and runs nothing", async (t) => {
	const s = seam(t, "darwin");
	const app = "localstudio://app/Calculator";
	assert.deepEqual(await answerOpen({ type: "open", id: 1, link: app }, s), { type: "open", id: 1, result: { done: "Opened Calculator." } });
	for (const frame of [{ id: 2, link: app, args: ["-n"] }, { id: 2, link: 5 }, { id: 2 }, { id: 2, link: "localstudio://settings/Skills" }, { id: 2, link: "localstudio://browser/history" }, { id: 2, link: "localstudio://app/../x" }])
		assert.equal((await answerOpen({ type: "open", ...frame }, s)).error.code, "bad_params", JSON.stringify(frame));
	for (const id of [undefined, "1", 1.5]) assert.equal(await answerOpen({ type: "open", id, link: app }, s), undefined);
	assert.equal(s.started.length, 1);
	const broken = seam(t, "darwin", { start: async () => Promise.reject(new Error("exit 1")) });
	assert.match((await answerOpen({ type: "open", id: 3, link: "localstudio://system/sound" }, broken)).error.message, /didn't open: exit 1/);
});

test("a program that can't start or fails at once is told apart from one that goes on", { skip: process.platform === "win32" }, async (t) => {
	const { start } = await loadTs(`export { start } from "@src/open-link.ts";`);
	await assert.rejects(start("/nonexistent/program", []));
	await assert.rejects(start("/bin/sh", ["-c", "exit 3"]), /exit 3/);
	await start("/bin/sh", ["-c", "exit 0"]);
	t.diagnostic("started");
});
