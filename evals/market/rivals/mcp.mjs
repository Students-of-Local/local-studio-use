// A small MCP stdio client wrapper with a call counter, shared by the MCP-based adapters.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function connectMcp({ command, args = [], env = {}, cwd, name = "local-studio-market", onAsk }) {
	const client = new Client({ name, version: "0.0.0" }, { capabilities: { elicitation: {} } });
	const asked = [];
	client.setRequestHandler(ElicitRequestSchema, async (req) => {
		asked.push(req.params.message);
		if (onAsk) return onAsk(req);
		const content = {};
		for (const [k, v] of Object.entries(req.params.requestedSchema?.properties ?? {})) content[k] = v.enum ? v.enum[0] : true;
		return { action: "accept", content };
	});
	const transport = new StdioClientTransport({ command, args, cwd, env: { ...process.env, ...env }, stderr: process.env.MARKET_DEBUG ? "inherit" : "ignore" });
	await client.connect(transport);
	const call = async (tool, a = {}, timeout = 60_000) => {
		const r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout });
		const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		return { ok: !r.isError, text, content: r.content };
	};
	return { client, call, asked, close: () => client.close() };
}

/** Wrap a call function with a step counter; `tool` throws on a tool error, `try` does not. */
export function counter(call) {
	let calls = 0;
	let cancelled = false;
	return {
		get calls() {
			return calls;
		},
		cancel() {
			cancelled = true;
		},
		async try(name, args) {
			if (cancelled) throw new Error("cancelled after timeout");
			calls++;
			return call(name, args);
		},
		async tool(name, args) {
			if (cancelled) throw new Error("cancelled after timeout");
			calls++;
			const r = await call(name, args);
			if (!r.ok) throw new Error(`${name} failed: ${r.text.slice(0, 400)}`);
			return r.text;
		},
	};
}
