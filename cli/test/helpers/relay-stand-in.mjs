// A relay to dial in a test: the stand-in speaks protocol v1 (docs/INTERFACE.md in baney75/local-studio-tunnels, Relay) on a local
// port, so nothing that uses it reaches Cloudflare.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

function frame(kind, id, payload) {
	const out = Buffer.alloc(5 + payload.length);
	out[0] = kind;
	out.writeUInt32BE(id, 1);
	payload.copy(out, 5);
	return out;
}

/**
 * The relay's job, done locally: a connector WebSocket at /_relay/connect behind the bearer key, health at /_relay/health, and every
 * other request sent down it as `req` with the public Host, the answer streamed back from `res`, DATA and `end`.
 */
export async function standIn(key) {
	const wss = new WebSocketServer({ noServer: true });
	const relay = { conn: null, connects: 0, port: 0 };
	const open = new Map();
	let nextId = 1;
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://relay");
		if (url.pathname === "/_relay/connect") {
			res.writeHead(req.headers.authorization === `Bearer ${key}` ? 426 : 401).end();
			return;
		}
		if (url.pathname === "/_relay/health") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, connected: relay.conn !== null }));
			return;
		}
		if (!relay.conn) {
			res.writeHead(503).end("No connector.");
			return;
		}
		const id = nextId++;
		open.set(id, res);
		const headers = [];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const name = req.rawHeaders[i].toLowerCase();
			if (!HOP.has(name) && name !== "host") headers.push([name, req.rawHeaders[i + 1]]);
		}
		headers.push(["host", `127.0.0.1:${relay.port}`], ["x-forwarded-proto", "https"]);
		const parts = [];
		req.on("data", (b) => parts.push(b));
		req.on("end", () => {
			const body = Buffer.concat(parts);
			relay.conn.send(JSON.stringify({ v: 1, t: "req", id, method: req.method, path: req.url, headers, body: body.length > 0, ws: false }));
			if (body.length) {
				relay.conn.send(frame(1, id, body));
				relay.conn.send(JSON.stringify({ v: 1, t: "end", id }));
			}
		});
	});
	server.on("upgrade", (req, socket, head) => {
		if (new URL(req.url, "http://relay").pathname !== "/_relay/connect" || req.headers.authorization !== `Bearer ${key}`) {
			socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			relay.conn = ws;
			relay.connects++;
			ws.send(JSON.stringify({ v: 1, t: "hello", maxBody: 10 * 1024 * 1024, maxInFlight: 64, headTimeoutMs: 60_000 }));
			ws.on("close", () => {
				if (relay.conn === ws) relay.conn = null;
			});
			ws.on("message", (data, binary) => {
				if (binary) {
					const id = data.readUInt32BE(1);
					if (data[0] === 1) open.get(id)?.write(data.subarray(5));
					return;
				}
				const m = JSON.parse(String(data));
				if (m.t === "ping") return ws.send('{"v":1,"t":"pong"}');
				const res = open.get(m.id);
				if (!res) return;
				if (m.t === "res") {
					for (const [name, value] of m.headers) if (!HOP.has(name)) res.appendHeader(name, value);
					res.writeHead(m.status);
				} else if (m.t === "end") {
					open.delete(m.id);
					res.end();
				} else if (m.t === "error") {
					open.delete(m.id);
					if (!res.headersSent) res.writeHead(502);
					res.end();
				}
			});
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	relay.port = server.address().port;
	relay.url = `http://127.0.0.1:${relay.port}`;
	relay.close = () =>
		new Promise((resolve) => {
			relay.conn?.terminate();
			wss.close();
			server.close(() => resolve());
			server.closeAllConnections();
		});
	return relay;
}

export function freePort() {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

/** Resolves once `ok` answers true, or fails naming `what`. */
export async function until(ok, what, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
