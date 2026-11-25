// Host focus changes for scripts/vm-bench.mjs: the helper's focus-watch prints one line per app activation on this Mac.

import { spawn } from "node:child_process";

/**
 * Starts `<helper> focus-watch` and resolves once it is watching; rejects when it stops before that. stop() ends it, waits for what
 * it already printed, and answers the bundle ids it saw, or undefined when it had died on its own (its count means nothing).
 */
export function watchFocus(helper) {
	const child = spawn(helper, ["focus-watch"], { stdio: ["ignore", "pipe", "inherit"] });
	const seen = [];
	let died = false;
	let stopping = false;
	const closed = new Promise((done) => {
		child.once("close", done);
		child.once("error", done);
	}).then((code) => {
		// focus-watch exits 0 only when told to stop.
		died = !stopping || code !== 0;
	});
	const stop = async () => {
		stopping = !died && child.exitCode === null && child.signalCode === null;
		if (stopping) child.kill("SIGTERM");
		await closed;
		return died ? undefined : seen;
	};
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => reject(new Error(`${helper} focus-watch exited ${code} before it was watching`)));
		let buf = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			const lines = (buf + chunk).split("\n");
			buf = lines.pop();
			for (const line of lines) {
				if (line === "watching") resolve({ stop });
				else if (line.startsWith("activated ")) seen.push(line.slice(10));
			}
		});
	});
}
