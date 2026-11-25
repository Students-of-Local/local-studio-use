/**
 * Per-hop timing of tool calls, for finding where a call's milliseconds go (docs/verification/speed-trace.md). Off
 * unless LOCAL_STUDIO_BROWSER_TRACE is set: to a file path, each tool call appends one JSON line there; to "1", it goes to stderr.
 *
 * A traced call carries a list of marks (label, epoch ms) from the MCP handler through the client, the host and the
 * extension, which each add their own, and back. The line written per tool call has the tool's name, its total ms,
 * and every mark as ms since the handler began, in the order they were made:
 *   {"tool":"click","ms":6.1,"marks":[["mcp.in",0],["client.send",0.2],["host.in",0.4],...,["mcp.out",6.1]]}
 * Nothing in a result changes, and an untraced call sends no marks at all.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { type TraceMark, traceNow } from "../../src/bridge/protocol.ts";
import { envVar } from "./env.ts";

export interface HopTracer {
	/** For BridgeClient's options: the marks of each bridge call made inside a traced tool call go to that call. */
	client: { onTrace: (method: string, marks: TraceMark[], context: unknown) => void; traceContext: () => unknown };
	/** Wrap a tool handler: its marks are collected and written when it returns. */
	wrap<A extends unknown[], R>(name: string, handler: (...args: A) => R | Promise<R>): (...args: A) => Promise<R>;
}

/** The tracer LOCAL_STUDIO_BROWSER_TRACE asks for, or undefined when tracing is off. */
export function hopTracer(dest = envVar("TRACE")): HopTracer | undefined {
	if (!dest) return undefined;
	const store = new AsyncLocalStorage<TraceMark[]>();
	const write = (line: string) => {
		try {
			if (dest === "1") process.stderr.write(`[local-studio-trace] ${line}\n`);
			else appendFileSync(dest, `${line}\n`);
		} catch {
			/* tracing never fails a call */
		}
	};
	return {
		client: {
			traceContext: () => store.getStore(),
			onTrace: (method, marks, context) => {
				const into = context as TraceMark[] | undefined;
				if (into) into.push(...marks);
				else write(JSON.stringify({ method, marks: relative(marks) }));
			},
		},
		wrap(name, handler) {
			return async (...args) => {
				const marks: TraceMark[] = [["mcp.in", traceNow()]];
				try {
					return await store.run(marks, () => handler(...args));
				} finally {
					marks.push(["mcp.out", traceNow()]);
					const rel = relative(marks);
					write(JSON.stringify({ tool: name, ms: rel[rel.length - 1][1], marks: rel }));
				}
			};
		},
	};
}

/** Marks as ms since the first one, to a tenth of a ms. */
function relative(marks: TraceMark[]): TraceMark[] {
	const t0 = marks[0]?.[1] ?? 0;
	return marks.map(([label, at]) => [label, Math.round((at - t0) * 10) / 10]);
}
