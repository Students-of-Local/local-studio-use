// Local Studio's session store for the chat sync tests: a stand-in daemon that keeps sessions the way eukhe 0.10.78 does
// (a `<id>.jsonl` file is listed at once and becomes a `<id>/` folder when it is opened), or with
// LOCAL_STUDIO_BROWSER_TEST_EUKHE=<program> the real daemon on a scratch home with a stub model. Both are driven through
// the daemon's own socket, as the app does.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const REAL = process.env.LOCAL_STUDIO_BROWSER_TEST_EUKHE;

function client(path) {
	const socket = createConnection(path);
	socket.setEncoding("utf8");
	let buffer = "";
	let seq = 0;
	let protocol;
	const waiting = new Map();
	const ready = new Promise((resolve, reject) => {
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, cut) || "{}");
				buffer = buffer.slice(cut + 1);
				if (frame.type === "daemon_hello") {
					protocol = frame.protocol;
					resolve();
				} else if (frame.type === "response") {
					waiting.get(frame.id)?.(frame);
					waiting.delete(frame.id);
				}
			}
		});
	});
	return {
		ready,
		async call(command, tries = 10) {
			await ready;
			const id = `app${++seq}`;
			const frame = await new Promise((resolve) => {
				waiting.set(id, resolve);
				socket.write(`${JSON.stringify({ type: "command", id, protocol, clientId: "app", command })}\n`);
			});
			// A session just opened refuses commands for a moment.
			if (!frame.success && /still initializing|not connected/.test(frame.error) && tries > 0) return sleep(300).then(() => this.call(command, tries - 1));
			if (!frame.success) throw new Error(`${command.type}: ${frame.error}`);
			return frame.data ?? {};
		},
		close: () => socket.destroy(),
	};
}

/** The stand-in: sessions in memory and in folders, the commands the sync uses, and `prompt` that answers "Answer to <text>". */
async function fakeDaemon(path, sessions) {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	mkdirSync(sessions, { recursive: true });
	const live = new Map();
	let n = 0;
	const sockets = new Set();
	const file = (folder) => join(folder, "main.jsonl");
	// The session in one line of its own, and its messages as the commits the real store writes (format 1).
	const load = (folder) => JSON.parse(readFileSync(join(folder, "fake.json"), "utf8"));
	const store = (folder, s) => {
		writeFileSync(join(folder, "fake.json"), JSON.stringify(s));
		const entry = ({ role, ...m }) => (role === "custom" ? { kind: "eukhe.custom", data: m } : { kind: { user: "pi.user", assistant: "pi.assistant", toolResult: "pi.tool-result" }[role], model: [{ role, ...m }] });
		const commits = [{ writes: [{ type: "conversation", value: { id: 1 } }] }, ...s.messages.map((m, i) => ({ writes: [{ type: "entry", value: { ...entry(m), id: i + 2, conversationId: 1 } }] }))];
		writeFileSync(file(folder), `${commits.map((c, i) => JSON.stringify({ format: 1, type: "commit", seq: i + 1, ...c })).join("\n")}\n`);
	};
	const imported = (jsonl) => {
		const lines = readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		return { id: lines[0].id, cwd: lines[0].cwd, name: lines.find((l) => l.type === "session_info")?.name, messages: lines.filter((l) => l.type === "message").map((l) => l.message) };
	};
	const liveRow = (folder, id) => {
		const activeSessionId = `live-${++n}`;
		live.set(activeSessionId, { folder, id, streaming: false });
		return { activeSessionId, sessionId: id };
	};
	const open = (sessionPath, cwd, noSession) => {
		const id = sessionPath ? sessionPath.replace(/\.jsonl$/, "").split("/").pop() : `app-${++n}`;
		const folder = join(sessions, id);
		if (!existsSync(folder)) {
			const jsonl = `${folder}.jsonl`;
			const s = existsSync(jsonl) ? imported(jsonl) : { id, cwd, name: "", messages: [] };
			// Kept nowhere, as the panel's own sessions ask: the stand-in has it in memory only as a live row.
			if (noSession) return liveRow(folder, id);
			mkdirSync(folder);
			store(folder, s);
		}
		return liveRow(folder, id);
	};
	const rows = () => {
		const ids = new Set(readdirSync(sessions).filter((f) => !f.startsWith(".")).map((f) => f.replace(/\.jsonl$/, "")));
		return [...ids].map((id) => {
			const folder = join(sessions, id);
			const s = existsSync(folder) ? load(folder) : imported(`${folder}.jsonl`);
			const said = s.messages.filter((m) => m.role === "user" || m.role === "assistant");
			const textOf = (m) => [].concat(m.content).filter((c) => c.type === "text").map((c) => c.text).join(" ");
			return { id, path: existsSync(folder) ? folder : `${folder}.jsonl`, cwd: s.cwd, name: s.name, rlmDepth: 0, modified: new Date(Math.max(0, ...s.messages.map((m) => m.timestamp))).toISOString(), messageCount: said.length, firstMessage: said[0] ? textOf(said[0]) : "", allMessagesText: said.map(textOf).join("\n"), model: { provider: "stub", modelId: "stub-model" } };
		});
	};
	const commands = [];
	const run = async (c, socket) => {
		commands.push(c.type);
		const s = live.get(c.activeSessionId);
		switch (c.type) {
			case "list":
				return { sessions: [...live].map(([activeSessionId, l]) => ({ activeSessionId, sessionId: l.id, isStreaming: l.streaming, sessionActions: { queuedCount: 0 } })) };
			case "list_saved_sessions":
				return { sessions: rows().filter((r) => c.scope !== "current" || r.cwd === c.cwd) };
			case "create": {
				const made = open(c.sessionPath, c.config?.cwd, c.noSession || c.config?.noSession);
				if (c.lifecycle === "client_owned") live.get(made.activeSessionId).owner = socket;
				return made;
			}
			case "get_messages":
				if (!s) throw new Error("Unknown active session");
				return { messages: load(s.folder).messages };
			case "set_session_name":
				store(s.folder, { ...load(s.folder), name: c.name });
				return {};
			case "rename_saved_session":
				if ([...live.values()].some((l) => l.folder === c.sessionPath)) throw new Error("Session is already active");
				store(c.sessionPath, { ...load(c.sessionPath), name: c.name });
				return {};
			case "append_custom_message": {
				const saved = load(s.folder);
				saved.messages.push({ role: "custom", ...c.message, timestamp: Date.now() });
				store(s.folder, saved);
				return {};
			}
			case "kill":
				live.delete(c.activeSessionId);
				return {};
			case "delete_saved_session":
				if ([...live.values()].some((l) => l.folder === c.sessionPath)) throw new Error("Session is already active");
				rmSync(c.sessionPath, { recursive: true, force: true });
				rmSync(`${c.sessionPath}.jsonl`, { force: true });
				return {};
			case "prompt": {
				const saved = load(s.folder);
				const at = Date.now();
				saved.messages.push({ role: "user", content: [{ type: "text", text: c.message }], timestamp: at });
				store(s.folder, saved);
				s.streaming = true;
				void sleep(c.message.includes("slow") ? 1500 : 20).then(() => {
					saved.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: `Answer to ${c.message}` }], api: "openai-completions", provider: "stub", model: "stub-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: at + 5 });
					store(s.folder, saved);
					s.streaming = false;
				});
				return {};
			}
			default:
				throw new Error(`Unknown command ${c.type}`);
		}
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "eukhe.daemon", version: 7 } })}\n`);
		let buffer = "";
		socket.on("data", async (chunk) => {
			buffer += chunk;
			for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
				const { id, command } = JSON.parse(buffer.slice(0, cut));
				buffer = buffer.slice(cut + 1);
				const answer = await run(command, socket).then(
					(data) => ({ success: true, data }),
					(err) => ({ success: false, error: err.message }),
				);
				if (!socket.destroyed) socket.write(`${JSON.stringify({ type: "response", id, command: command.type, ...answer })}\n`);
			}
		});
		socket.on("close", () => {
			sockets.delete(socket);
			for (const [id, l] of live) if (l.owner === socket) live.delete(id);
		});
		socket.on("error", () => undefined);
	});
	await new Promise((r) => server.listen(path, r));
	return {
		commands,
		async close() {
			for (const s of sockets) s.destroy();
			await new Promise((r) => server.close(r));
		},
	};
}

async function realDaemon(program, path, agent, home) {
	const model = createHttp((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", async () => {
			const asked = JSON.parse(body || "{}").messages?.filter((m) => m.role === "user").pop()?.content;
			const said = typeof asked === "string" ? asked : (asked ?? []).map((c) => c.text ?? "").join(" ");
			const want = /MARK\S+/.exec(said)?.[0] ?? "you";
			if (said.includes("slow")) await sleep(2500);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "stub-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			res.end(`${chunk({ role: "assistant", content: `Answer to ${want}` })}${chunk({}, "stop")}data: [DONE]\n\n`);
		});
	});
	await new Promise((r) => model.listen(0, "127.0.0.1", r));
	mkdirSync(agent, { recursive: true, mode: 0o700 });
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: "openai-completions", apiKey: "none", models: [{ id: "stub-model", name: "stub-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { stub: provider } }));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model" }));
	writeFileSync(join(agent, "auth.json"), "{}");
	const child = spawn(program, ["--mode", "daemon", "--daemon-socket", path], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(path, ".."), EUKHE_CODING_AGENT_DIR: agent }, stdio: "ignore" });
	for (let i = 0; i < 100 && !existsSync(`${path}.pid`); i++) await sleep(100);
	await sleep(500);
	return {
		commands: [],
		async close() {
			child.kill();
			await new Promise((r) => child.once("exit", r));
			await new Promise((r) => model.close(r));
		},
	};
}

/** A scratch home with a daemon (or none yet): what the app would do, through the socket. */
export async function startWorld(root) {
	const home = join(root, "home");
	const agent = join(home, ".eukhe");
	const path = join(root, "d", "daemon.sock");
	const sessions = join(agent, "sessions");
	mkdirSync(agent, { recursive: true, mode: 0o700 });
	const daemon = REAL ? await realDaemon(REAL, path, agent, home) : await fakeDaemon(path, sessions);
	const app = client(REAL && process.platform === "linux" ? `\0${path}` : path);
	await app.ready;
	const liveOf = async (sid) => (await app.call({ type: "list" })).sessions.find((s) => s.sessionId === sid);
	const openIn = async (sid) => {
		const l = await liveOf(sid);
		if (l) return l.activeSessionId;
		const at = existsSync(join(sessions, sid)) ? join(sessions, sid) : join(sessions, `${sid}.jsonl`);
		return (await app.call({ type: "create", ...(existsSync(at) ? { sessionPath: at } : {}), config: { cwd: home, provider: "stub", model: "stub-model" } })).activeSessionId;
	};
	return {
		home,
		agent,
		sessions,
		path,
		app,
		daemon,
		open: openIn,
		async turn(sid, message, wait = true) {
			const activeSessionId = await openIn(sid);
			await app.call({ type: "attach", activeSessionId, clientKind: "interactive" }).catch(() => undefined);
			await app.call({ type: "prompt", activeSessionId, message });
			for (let i = 0; wait && i < 100; i++) {
				await sleep(100);
				const { messages } = await app.call({ type: "get_messages", activeSessionId });
				const l = (await app.call({ type: "list" })).sessions.find((s) => s.activeSessionId === activeSessionId);
				if (messages.at(-1)?.role === "assistant" && !l?.isStreaming) return messages;
			}
		},
		async messages(sid) {
			return (await app.call({ type: "get_messages", activeSessionId: await openIn(sid) })).messages;
		},
		async end(sid) {
			const l = await liveOf(sid);
			if (l) await app.call({ type: "kill", activeSessionId: l.activeSessionId });
		},
		async close() {
			app.close();
			await daemon.close();
		},
	};
}
