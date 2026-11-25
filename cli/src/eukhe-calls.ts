/** One connection to Local Studio's daemon for the host's own calls (cli/src/chat-sync.ts): a command, its answer. */

import { connectDaemon, eukheSocketPaths } from "./eukhe.ts";

/** How long the daemon has to answer one command. */
const CALL_MS = 20_000;

export class DaemonCalls {
	private readonly pending = new Map<string, { resolve: (data: Record<string, unknown>) => void; reject: (err: Error) => void }>();
	private link: Awaited<ReturnType<typeof connectDaemon>> | undefined;
	private seq = 0;

	private constructor() {}

	/** Run `fn` on a connection of its own, closed after. Rejects (eukhe_unavailable) when no daemon answers. */
	static async with<T>(fn: (daemon: DaemonCalls) => Promise<T>, paths: readonly string[] = eukheSocketPaths()): Promise<T> {
		const calls = new DaemonCalls();
		calls.link = await connectDaemon(paths, (frame) => calls.onFrame(frame), () => calls.onClose());
		try {
			return await fn(calls);
		} finally {
			calls.link.socket.destroy();
		}
	}

	/** The answer's data; rejects with the daemon's own words. */
	call(command: Record<string, unknown>, ms = CALL_MS): Promise<Record<string, unknown>> {
		const { link } = this;
		if (!link || link.socket.destroyed) return Promise.reject(new Error("the daemon connection closed"));
		const id = `local_studio_chats_${process.pid}_${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`no answer to ${String(command.type)} within ${ms} ms`));
			}, ms);
			const settle = <A>(fn: (arg: A) => void) => (arg: A) => {
				clearTimeout(timer);
				fn(arg);
			};
			this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			link.socket.write(`${JSON.stringify({ type: "command", id, protocol: link.protocol, clientId: `local-studio-chats:${process.pid}`, command })}\n`);
		});
	}

	private onFrame(frame: Record<string, unknown>): void {
		if (frame.type !== "response" || typeof frame.id !== "string") return;
		const waiting = this.pending.get(frame.id);
		if (!waiting) return;
		this.pending.delete(frame.id);
		if (frame.success === true) waiting.resolve((frame.data ?? {}) as Record<string, unknown>);
		else waiting.reject(new Error(String(frame.error ?? `${String(frame.command)} failed`)));
	}

	private onClose(): void {
		for (const { reject } of this.pending.values()) reject(new Error("the daemon connection closed"));
		this.pending.clear();
	}
}
