/**
 * `local-studio-browser update --host [--activate|--rollback|--reinstall]`: the update the native host runs
 * for the side panel, as a child process. It prints one JSON line per step ({phase, message})
 * and a last one with phase "done" or "failed"; the host forwards them to the extension. Each
 * line is also written to ~/.local-studio/browser/update-progress.json, so a host that restarts (the
 * browser restarted it, or the extension reloaded) can pick up a run already going.
 *
 * An update has two steps, so the browser never runs a mix of old and new files for long:
 *   --host            check, download or pull, build, and stage the result. Nothing live changes.
 *   --host --activate swap the staged build in, record What's new. The extension
 *                     asks for this only when no agent runs, and reloads right after.
 *
 * What "update" means depends on how Local Studio runs (detectMode):
 *   release:   the signed GitHub release flow of update.ts, with its checks unchanged.
 *   checkout:  fetch, git pull --ff-only on main, setup-siblings, build (checkout.ts).
 *   unmanaged: an npm install, a copied folder or a folder of a larger repository; refused, with what to run instead.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdatePhase } from "../../src/bridge/protocol.ts";
import { describeBuild } from "../../src/update/build.ts";
import { activateCheckout, detectMode, readBuildInfo, recoverCheckoutQuietly, rollbackCheckout, unmanagedReason, updateCheckout } from "./checkout.ts";
import { writeJsonPrivate } from "./files.ts";
import { type HostRunAction, type ProgressEvent, type ProgressRecord, progressFile } from "./update-progress.ts";
import {
	appDir,
	checkForUpdate,
	configDir,
	downloadVerified,
	installedVersion,
	installRoot,
	isNewer,
	latestRelease,
	previousDir,
	readSettings,
	readStatus,
	recover,
	reinstallHost,
	stage,
	stagedDir,
	swapBack,
	swapIn,
	UpdateError,
	withLock,
	writeLastUpdate,
	writeStatus,
} from "./update.ts";

export type { HostRunAction, ProgressEvent, ProgressRecord } from "./update-progress.ts";

let currentAction: HostRunAction = "update";

function emit(event: ProgressEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
	try {
		mkdirSync(configDir(), { recursive: true, mode: 0o700 });
		const record: ProgressRecord = { ...event, pid: process.pid, action: currentAction, at: Date.now() };
		const tmp = `${progressFile()}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record)}\n`);
		renameSync(tmp, progressFile());
	} catch {
		/* the stream to the host still has it */
	}
}

const phase = (p: UpdatePhase, message: string) => emit({ phase: p, message });

/** Swallow the log lines of the terminal flow; the steps are reported as phases instead. */
const quiet = (_line: string) => {};

const WHEN_IDLE = "It installs when no agent is running, then the extension reloads.";

// ---- release mode -------------------------------------------------------------------------

interface ReleasePending {
	from: string;
	to: string;
	notes?: string;
	url?: string;
}

const pendingFile = () => join(stagedDir(), ".pending.json");

async function releaseUpdate(): Promise<void> {
	const { channel } = readSettings();
	phase("checking", `Checking GitHub for the newest ${channel} release`);
	if (existsSync(installRoot())) withLock(recover);
	const status = await checkForUpdate(channel);
	if (status.error) throw new UpdateError(status.error);
	if (!status.latest) {
		emit({ phase: "done", message: `No ${channel} release is published yet.` });
		return;
	}
	if (!status.available) {
		emit({ phase: "done", message: `Up to date (${status.current}).` });
		return;
	}
	const release = await latestRelease(channel);
	if (!release || release.version !== status.latest) throw new UpdateError("The release list changed during the update; run it again.");
	const zip = await downloadVerified(release, quiet, phase);
	phase("installing", `Unpacking ${release.version}`);
	withLock(() => {
		recover();
		rmSync(stagedDir(), { recursive: true, force: true });
		renameSync(stage(zip, release.version), stagedDir());
		const pending: ReleasePending = { from: status.current, to: release.version, notes: release.notes, url: release.url };
		writeJsonPrivate(pendingFile(), pending);
	});
	emit({ phase: "done", message: `Downloaded and verified ${release.version}. ${WHEN_IDLE}`, staged: true });
}

function releaseActivate(): void {
	let pending: ReleasePending | undefined;
	phase("installing", "Installing the verified release");
	withLock(() => {
		recover();
		if (!existsSync(pendingFile())) return;
		const staged = JSON.parse(readFileSync(pendingFile(), "utf8")) as ReleasePending;
		if (installedVersion(stagedDir()) !== staged.to) throw new UpdateError(`The staged release is not ${staged.to}; run Update now again.`);
		// Never install something older than what runs (say, staged before a rollback or a terminal update).
		if (!isNewer(staged.to, installedVersion(appDir()))) {
			rmSync(stagedDir(), { recursive: true, force: true });
			return;
		}
		// The record moves out of the folder that becomes app/, and goes only once the swap is done.
		const aside = join(installRoot(), ".pending-activating.json");
		renameSync(pendingFile(), aside);
		pending = staged;
		swapIn(stagedDir());
		rmSync(aside, { force: true });
	});
	if (!pending) {
		emit({ phase: "done", message: "Nothing was waiting to install." });
		return;
	}
	const done = pending;
	// The launcher already points at app/ (this host runs from it), so a failed re-registration
	// only means the manifest wasn't refreshed; say so instead of hiding it.
	const registered = reinstallHost(quiet);
	const status = readStatus();
	if (status) writeStatus({ ...status, current: done.to, available: false, checkedAt: Date.now() });
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "update", mode: "release", at: Date.now(), from: done.from, to: done.to, notes: done.notes, url: done.url, extensionBuild });
	const warn = registered ? "" : ` Registering the native host again failed; run: node ${join(appDir(), "cli", "dist", "index.js")} install.`;
	emit({ phase: "done", message: `Installed ${done.to}.${warn}`, reload: true, extensionBuild });
}

function releaseRollback(): void {
	phase("installing", `Rolling back to the release in ${previousDir()}`);
	withLock(() => rmSync(stagedDir(), { recursive: true, force: true }));
	const { from, to } = swapBack(quiet);
	const registered = reinstallHost(quiet);
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "rollback", mode: "release", at: Date.now(), from: from ?? "?", to: to ?? "?", extensionBuild });
	const warn = registered ? "" : ` Registering the native host again failed; run: node ${join(appDir(), "cli", "dist", "index.js")} install.`;
	emit({ phase: "done", message: `Rolled back ${from ?? "?"} to ${to ?? "?"}.${warn}`, reload: true, extensionBuild });
}

function releaseReinstall(): void {
	phase("installing", "Registering the native host and launcher from the installed release");
	if (!reinstallHost(quiet)) throw new UpdateError(`Registering the native host from ${appDir()} failed. Run: node ${join(appDir(), "cli", "dist", "index.js")} install`);
	const version = installedVersion(appDir()) ?? "?";
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "reinstall", mode: "release", at: Date.now(), from: version, to: version, extensionBuild });
	emit({ phase: "done", message: `Re-ran the install step for ${version}.`, reload: true, extensionBuild });
}

// ---- checkout mode ------------------------------------------------------------------------

async function checkoutUpdate(root: string, pull: boolean): Promise<void> {
	const result = await updateCheckout(root, phase, { pull });
	if (!result.changed) {
		emit({ phase: "done", message: result.message });
		return;
	}
	const n = result.staged?.commits?.total ?? 0;
	const pulled = n ? ` (${n} new commit${n === 1 ? "" : "s"})` : "";
	emit({ phase: "done", message: `${result.message}${pulled}. ${WHEN_IDLE}`, staged: true });
}

function checkoutActivate(root: string): void {
	phase("installing", "Swapping in the new build");
	const staged = activateCheckout(root);
	if (!staged) {
		emit({ phase: "done", message: "Nothing was waiting to install." });
		return;
	}
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	writeLastUpdate({
		id: randomUUID(),
		kind: "update",
		mode: "checkout",
		at: Date.now(),
		from: staged.from,
		to: staged.to,
		commits: staged.commits?.commits,
		totalCommits: staged.commits?.total,
		url: staged.commits?.url,
		extensionBuild,
	});
	emit({ phase: "done", message: `Installed ${staged.to}.`, reload: true, extensionBuild });
}

function checkoutRollback(root: string): void {
	phase("installing", "Swapping back to the previous build");
	const { from, to } = rollbackCheckout(root);
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "rollback", mode: "checkout", at: Date.now(), from: describeBuild(from), to: describeBuild(to), extensionBuild });
	emit({
		phase: "done",
		message: `Rolled back the build ${describeBuild(from)} to ${describeBuild(to)}. The git checkout stays where it is; Update now builds it again.`,
		reload: true,
		extensionBuild,
	});
}

// ---- entry --------------------------------------------------------------------------------

/** A host action this helper doesn't run (the Local Studio app updates a compiled helper): one failed step that says why. */
export function refuseHostAction(action: HostRunAction, message: string): number {
	currentAction = action;
	emit({ phase: "failed", message });
	return 1;
}

export async function runHostAction(action: HostRunAction): Promise<number> {
	currentAction = action;
	// The host may exit (the extension reloaded) while this runs: keep going without its pipe.
	process.stdout.on("error", () => {});
	const { mode, root } = detectMode();
	try {
		if (mode === "unmanaged") throw new UpdateError(unmanagedReason(root));
		if (mode === "release") {
			if (action === "update") await releaseUpdate();
			else if (action === "activate") releaseActivate();
			else if (action === "rollback") releaseRollback();
			else releaseReinstall();
		} else if (action === "rollback") checkoutRollback(root);
		else if (action === "activate") checkoutActivate(root);
		else await checkoutUpdate(root, action === "update");
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (action === "activate" || action === "rollback") {
			// It may have stopped after files changed. Finish or undo the swap first (the journal in a
			// checkout, recover() for a release), then reload into what is installed, under the gate.
			try {
				if (mode === "checkout") recoverCheckoutQuietly(root);
				else if (mode === "release") withLock(recover);
			} catch {
				/* the next updater or host start repairs it; the mismatch banner shows meanwhile */
			}
			const extensionBuild = readBuildInfo(join(mode === "release" ? appDir() : root, "dist-chrome"))?.id;
			emit({ phase: "failed", message: `${message} Reloading the extension to run what is installed.`, reload: true, extensionBuild });
		} else emit({ phase: "failed", message });
		return 1;
	}
}
