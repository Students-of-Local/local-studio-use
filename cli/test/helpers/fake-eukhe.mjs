// A stand-in for Local Studio's Eukhe daemon: a Unix socket server speaking eukhe.daemon v7 JSON lines, as eukhe 452f1be
// does (eukhe-types daemon command.rs, outbound.rs, session_event.rs). It greets each connection with daemon_hello,
// answers create, attach, prompt, abort, kill, get_available_models and get_last_assistant_text, and streams a scripted
// turn as session_event frames to the connections attached to the session (only those, as the real supervisor does).
//
//   const daemon = await startFakeEukhe({ path, turn: async (t) => { t.delta("Hi"); await t.tool("navigate", {...}, run); } });
//
// `turn(t)` runs for each prompt: t.delta(text) streams text, t.tool(name, args, run) streams one tool call around
// `run()`, t.shell(command) asks the attached clients about a shell step, t.aborted says the turn was aborted, t.message
// is the prompt. Without `turn`, a fixed turn streams two deltas, one tool call and a last delta.
// Each session has Eukhe's auto set (`shell.autoEffects`, every effect by default as in eukhe 452f1be), set by a `cvar`
// line. t.write(path) is a file write as Eukhe gates it: unasked when the auto set holds its effects, else it asks and
// runs only on an approve; `writes` lists those that ran. `cvar: false` refuses every cvar command.
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

export const DEFAULT_MODELS = [
	{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000 },
	{ id: "lfm2.5-8b", name: "LFM2.5 8B", provider: "llamacpp", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ALL_EFFECTS = ["read", "write", "exec", "net", "outside", "protected", "secret"];

export async function startFakeEukhe({ path, turn, models = DEFAULT_MODELS, stepMs = 15, hello = true, cvar = true } = {}) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	rmSync(path, { force: true });
	/** Every command received, in order: { type, ...fields }. */
	const commands = [];
	/** sessionId -> { attached: Set<socket>, aborted, busy, last } */
	const sessions = new Map();
	let nextSession = 0;
	const sockets = new Set();
	/** The writes that ran: { activeSessionId, path, asked }. */
	const writes = [];
	/** requestId -> resolve(verdict) for the questions out now. */
	const questions = new Map();

	const write = (socket, frame) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
	};
	const publish = (sessionId, event) => {
		for (const s of sessions.get(sessionId)?.attached ?? []) write(s, { type: "session_event", activeSessionId: sessionId, event });
	};

	const runTurn = async (sessionId, message) => {
		const session = sessions.get(sessionId);
		session.aborted = false;
		session.busy = true;
		let text = "";
		const content = [];
		const assistant = () => ({ role: "assistant", content: [...content, ...(text ? [{ type: "text", text }] : [])], stopReason: session.aborted ? "aborted" : "stop" });
		publish(sessionId, { type: "agent_start" });
		publish(sessionId, { type: "turn_start" });
		publish(sessionId, { type: "message_start", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "start" } });
		let tools = 0;
		const t = {
			message,
			get aborted() {
				return session.aborted;
			},
			async delta(piece) {
				if (session.aborted) return;
				text += piece;
				publish(sessionId, { type: "message_update", message: assistant(), assistantMessageEvent: { type: "text_delta", delta: piece } });
				await sleep(stepMs);
			},
			async tool(toolName, args, run = async () => ({ content: [{ type: "text", text: "ok" }] })) {
				if (session.aborted) return undefined;
				const toolCallId = `call_${++tools}`;
				publish(sessionId, { type: "tool_execution_start", toolCallId, toolName, args });
				let result;
				let isError = false;
				try {
					result = await run();
				} catch (err) {
					result = { content: [{ type: "text", text: String(err?.message ?? err) }] };
					isError = true;
				}
				publish(sessionId, { type: "tool_execution_end", toolCallId, toolName, result: { content: result.content, details: null }, isError });
				await sleep(stepMs);
				return result;
			},
			async write(target, body = "") {
				if (session.aborted) return undefined;
				const cwd = session.config?.cwd ?? process.cwd();
				const full = isAbsolute(target) ? target : join(cwd, target);
				const effects = ["write", ...(full.startsWith(`${cwd}/`) ? [] : ["outside"])];
				return this.tool("write", { path: full, content: body }, async () => {
					let asked = false;
					if (!effects.every((e) => session.autoEffects.includes(e))) {
						asked = true;
						const requestId = `write_${++tools}`;
						const verdict = new Promise((resolve) => questions.set(requestId, resolve));
						for (const s of session.attached) write(s, { type: "shell_approval", activeSessionId: sessionId, request: { requestId, step: 0, command: `write ${full}`, effects } });
						const said = await Promise.race([verdict, sleep(2000).then(() => "unanswered")]);
						questions.delete(requestId);
						if (said !== "approve") throw new Error(`(${effects.join(", ")}) the user did not approve this step`);
					}
					writes.push({ activeSessionId: sessionId, path: full, asked });
					return { content: [{ type: "text", text: `wrote ${full}` }] };
				});
			},
			async shell(command) {
				const requestId = `shell_${++tools}`;
				for (const s of session.attached) write(s, { type: "shell_approval", activeSessionId: sessionId, request: { requestId, step: 0, command, effects: {} } });
				await sleep(stepMs * 4);
			},
		};
		try {
			if (turn) await turn(t);
			else {
				await t.delta("Reading ");
				await t.delta("the page. ");
				await t.tool("get_page_text", {});
				await t.delta("It says hello.");
			}
		} finally {
			session.busy = false;
			session.last = text;
			const final = assistant();
			publish(sessionId, { type: "message_end", message: final });
			publish(sessionId, { type: "turn_end", message: final, toolResults: [] });
			publish(sessionId, { type: "agent_end", messages: [final] });
		}
	};

	const onCommand = (socket, envelope) => {
		const command = envelope.command ?? envelope;
		commands.push({ ...command, envelopeId: envelope.id, protocol: envelope.protocol });
		const respond = (success, data, error) => write(socket, { type: "response", id: envelope.id, command: command.type, success, ...(data ? { data } : {}), ...(error ? { error } : {}) });
		const session = sessions.get(command.activeSessionId);
		switch (command.type) {
			case "create": {
				const id = `session-${++nextSession}`;
				sessions.set(id, { attached: new Set(), aborted: false, busy: false, last: "", config: command.config, owner: socket, autoEffects: [...ALL_EFFECTS] });
				return respond(true, { activeSessionId: id });
			}
			case "attach":
				if (!session) return respond(false, undefined, `No session ${command.activeSessionId}`);
				session.attached.add(socket);
				return respond(true, { activeSessionId: command.activeSessionId });
			case "get_available_models":
				if (!session) return respond(false, undefined, "No session");
				return respond(true, { models });
			case "prompt":
				if (!session) return respond(false, undefined, "No session");
				respond(true, { accepted: true });
				void runTurn(command.activeSessionId, command.message);
				return;
			case "abort":
				if (!session) return respond(false, undefined, "No session");
				session.aborted = true;
				return respond(true, {});
			case "get_last_assistant_text":
				return respond(true, { text: session?.last ?? "" });
			case "kill":
				if (!session) return respond(false, undefined, "No session");
				sessions.delete(command.activeSessionId);
				for (const s of session.attached) write(s, { type: "session_closed", activeSessionId: command.activeSessionId, reason: "killed" });
				return respond(true, {});
			case "answer_shell_approval":
				questions.get(command.requestId)?.(command.verdict);
				return respond(true, {});
			case "cvar": {
				if (!session) return respond(false, undefined, "No session");
				if (!cvar) return respond(false, undefined, "Unknown command cvar");
				const set = /^set shell\.autoEffects (.*)$/.exec(command.line ?? "");
				const list = set?.[1].split(",").map((e) => e.trim()).filter(Boolean);
				if (command.global || !list?.every((e) => ALL_EFFECTS.includes(e))) return respond(false, undefined, `bad cvar line ${command.line}`);
				session.autoEffects = list;
				return respond(true, { values: [], errors: [] });
			}
			default:
				return respond(false, undefined, `Unknown command ${command.type}`);
		}
	};

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		if (hello) write(socket, { type: "daemon_hello", socketPath: path, protocol: { name: "eukhe.daemon", version: 7 }, appVersion: "fake-0.0.0", schemaId: "eukhe.daemon.schema" });
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let cut = buffer.indexOf("\n");
			while (cut >= 0) {
				const line = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 1);
				cut = buffer.indexOf("\n");
				if (line.trim()) onCommand(socket, JSON.parse(line));
			}
		});
		socket.on("close", () => {
			sockets.delete(socket);
			// Client-owned sessions end with their owner's connection.
			for (const [id, s] of sessions) {
				s.attached.delete(socket);
				if (s.owner === socket) sessions.delete(id);
			}
		});
		socket.on("error", () => undefined);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	return {
		path,
		commands,
		sessions,
		writes,
		/** Connections open now. */
		get connections() {
			return sockets.size;
		},
		async close() {
			for (const s of sockets) s.destroy();
			await new Promise((r) => server.close(r));
			rmSync(path, { force: true });
		},
	};
}
