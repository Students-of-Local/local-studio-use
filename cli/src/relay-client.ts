// Vendored, unchanged below this header, from baney75/local-studio-tunnels relay/client/relay-client.ts
// at commit 741ff1611f280b23e7fbad0862f0e71201a8f9c7 (2026-11-24). Change it upstream and copy it again;
// cli/test/relay-vendor.test.mjs fails when the body below stops matching that copy's SHA-256.
// License: the upstream file has no license header and its repository no license file. Both repositories are
// baney75's, and this copy is distributed under Local Studio's license (AGPL-3.0, LICENSE).
// ---- upstream file starts here ----
// Reference connector for the Local Studio relay (docs/INTERFACE.md, Relay).
// Node 22 or later, no dependencies: one file to vendor, checked with tsc.
//
// It dials the relay with the built-in WebSocket (which sends the Authorization
// header), reconnects with backoff, and forwards each request to a loopback
// origin by path. The origin leg uses node:http, so the public Host reaches the
// origin unchanged; the built-in WebSocket would replace it with the loopback
// address, so /v1/ws to the origin speaks RFC 6455 over an http upgrade here.
//
//   const relay = new RelayClient({ url: "https://name.sub.workers.dev", key });
//   relay.start();

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Duplex, Readable } from "node:stream";

/** Public path to loopback origin, as in docs/INTERFACE.md. */
export const DEFAULT_ROUTES: Readonly<Record<string, string>> = {
  "/v1/health": "http://127.0.0.1:18094",
  "/v1/ws": "http://127.0.0.1:18094",
  "/mcp": "http://127.0.0.1:8787",
  "/.well-known/oauth-protected-resource": "http://127.0.0.1:8787",
  "/.well-known/oauth-protected-resource/mcp": "http://127.0.0.1:8787",
  "/.well-known/oauth-authorization-server": "http://127.0.0.1:8787",
  "/.well-known/oauth-authorization-server/mcp": "http://127.0.0.1:8787",
  "/authorize": "http://127.0.0.1:8787",
  "/token": "http://127.0.0.1:8787",
  "/register": "http://127.0.0.1:8787",
  "/revoke": "http://127.0.0.1:8787",
};

export type RelayState =
  | "connecting"
  | "connected"
  | "disconnected" // retrying with backoff
  | "replaced" // another connector took over; not retrying
  | "unauthorized" // wrong key; not retrying
  | "outdated" // the relay speaks another protocol version; not retrying
  | "stopped";

export interface RelayClientOptions {
  /** The relay's address, for example https://name.sub.workers.dev. */
  url: string;
  /** RELAY_KEY. Never logged. */
  key: string;
  routes?: Readonly<Record<string, string>>;
  /** `error` says why start() could not run; only "stopped" ever carries one. */
  onState?: (state: RelayState, error?: string) => void;
  /** Keepalive period; the protocol says 30 seconds. */
  pingMs?: number;
}

const PING = '{"v":1,"t":"ping"}';
const PONG = '{"v":1,"t":"pong"}';
const DATA = 1;
const WS_TEXT = 2;
const WS_BINARY = 3;
const CHUNK = 64 * 1024;
/** Pause an origin response while this much is queued on the relay socket. */
const HIGH_WATER = 1024 * 1024;
/** Largest message accepted from an origin WebSocket. */
const MAX_MESSAGE = 16 * 1024 * 1024;
/** Most bytes held, over every stream, for origins that read slower than the relay sends. */
const MAX_QUEUED = 32 * 1024 * 1024;
const USER_AGENT = "local-studio-relay-client/1";

type Pairs = [string, string][];

interface Req {
  t: "req";
  id: number;
  method: string;
  path: string;
  headers: Pairs;
  body: boolean;
  ws: boolean;
}

interface Stream {
  req?: ClientRequest;
  /** Body bytes the request's content-length still promises; unset without one. */
  left?: number;
  res?: IncomingMessage;
  origin?: OriginSocket;
}

export class RelayClient {
  private readonly routes: Readonly<Record<string, string>>;
  private readonly pingMs: number;
  private ws: WebSocket | null = null;
  private streams = new Map<number, Stream>();
  private current: RelayState = "stopped";
  private attempt = 0;
  /** From start() until it stops for good. */
  private running = false;
  /** Counts starts and stops: work begun under an earlier run changes nothing. */
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private upSince = 0;

  private readonly opts: RelayClientOptions;

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
    this.routes = opts.routes ?? DEFAULT_ROUTES;
    this.pingMs = opts.pingMs ?? 30_000;
  }

  get state(): RelayState {
    return this.current;
  }

  /** Starts, or starts again after replaced, unauthorized, outdated or stopped. */
  start(): void {
    if (this.running) return;
    if (typeof WebSocket !== "function") {
      this.current = "stopped";
      this.opts.onState?.("stopped", "The relay client needs a built-in WebSocket (Node 22 or later); this runtime has none.");
      return;
    }
    this.running = true;
    this.run++;
    this.attempt = 0;
    this.upSince = 0;
    try {
      this.connect();
    } catch (e) {
      this.halt("stopped");
      throw e;
    }
  }

  stop(): void {
    this.halt("stopped");
  }

  private set(state: RelayState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }

  private connectUrl(): string {
    const u = new URL("/_relay/connect", this.opts.url);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    return u.href;
  }

  private connect(): void {
    const run = this.run;
    this.set("connecting");
    if (run !== this.run) return; // onState stopped or restarted the client
    const ws = new WebSocket(this.connectUrl(), {
      headers: { authorization: `Bearer ${this.opts.key}`, "user-agent": USER_AGENT },
    });
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      if (this.ws !== ws) return;
      this.upSince = Date.now();
      this.lastPong = Date.now();
      this.pinger = setInterval(() => this.keepalive(ws), this.pingMs);
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      // A throw here would reach the host app as an uncaught exception; one bad frame must not stop it.
      try {
        if (typeof e.data === "string") this.control(ws, e.data);
        else this.data(new Uint8Array(e.data as ArrayBuffer));
      } catch {
        // Dropped; a request that threw was already answered in open().
      }
    });
    const lost = (code: number): void => {
      if (this.ws !== ws) return;
      this.down();
      if (code === 4000) return this.halt("replaced");
      if (!opened) void this.probe(run);
      else this.retry();
    };
    ws.addEventListener("close", (e) => lost(e.code));
    // Node's WebSocket fires only error, never close, when the handshake is refused.
    ws.addEventListener("error", () => {
      if (!opened) lost(1006);
    });
  }

  private keepalive(ws: WebSocket): void {
    if (Date.now() - this.lastPong > 2 * this.pingMs) {
      // Dead without a close: drop it now rather than wait for TCP.
      this.down();
      try {
        ws.close();
      } catch {
        // Already closing.
      }
      return this.retry();
    }
    ws.send(PING);
  }

  /** A browser-style WebSocket can't read a refused handshake's status; ask once over plain HTTP. */
  private async probe(run: number): Promise<void> {
    let status = 0;
    try {
      const res = await fetch(new URL("/_relay/connect", this.opts.url), {
        headers: { authorization: `Bearer ${this.opts.key}`, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      await res.body?.cancel();
    } catch {
      // Offline or the relay is down; retry below.
    }
    if (run !== this.run) return;
    if (status === 401) this.halt("unauthorized");
    else this.retry();
  }

  private retry(): void {
    if (this.timer) return;
    // Start over only when the socket that just dropped had been up a minute; a
    // relay that is down, or one that keeps dropping, backs off to 30 s.
    if (this.upSince && Date.now() - this.upSince > 60_000) this.attempt = 0;
    this.upSince = 0;
    const base = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.connect();
      },
      base / 2 + Math.random() * (base / 2),
    );
    // Last: onState may call stop(), which clears the timer.
    this.set("disconnected");
  }

  /** The relay socket is gone: stop its timers and every stream on it. */
  private down(): void {
    clearInterval(this.pinger);
    this.pinger = undefined;
    this.ws = null;
    for (const id of [...this.streams.keys()]) this.abort(id);
  }

  private halt(state: RelayState): void {
    this.running = false;
    this.run++;
    clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.ws;
    this.down();
    try {
      ws?.close(1000, "stopped");
    } catch {
      // Already closed.
    }
    this.set(state);
  }

  private send(m: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ v: 1, ...m }));
  }

  /** Body bytes go in slices of at most 64 KiB; a WebSocket message is always one frame. */
  private sendFrame(kind: number, id: number, payload: Uint8Array): void {
    const step = kind === DATA ? CHUNK : Math.max(payload.byteLength, 1);
    for (let off = 0; off === 0 || off < payload.byteLength; off += step) {
      const part = payload.subarray(off, off + step);
      const f = new Uint8Array(5 + part.byteLength);
      f[0] = kind;
      new DataView(f.buffer).setUint32(1, id);
      f.set(part, 5);
      this.ws?.send(f);
    }
  }

  private control(ws: WebSocket, raw: string): void {
    if (raw === PONG) {
      this.lastPong = Date.now();
      return;
    }
    let m: { v?: number; t?: string; id?: number; [k: string]: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    if (m.t === "hello") {
      if (m.v !== 1) return this.halt("outdated");
      return this.set("connected");
    }
    // Close code 4000 follows, but Node reports a close only once TCP closes.
    if (m.t === "replaced") return this.halt("replaced");
    if (m.v !== 1 || typeof m.id !== "number") return;
    const s = this.streams.get(m.id);
    switch (m.t) {
      case "req":
        if (this.ws === ws) this.open(m as unknown as Req);
        return;
      case "end":
        if (s?.left) return this.fail(m.id, "body shorter than its content-length");
        s?.req?.end();
        return;
      case "cancel":
        return this.abort(m.id);
      case "ws_close":
        this.streams.delete(m.id);
        s?.origin?.close(Number(m.code), String(m.reason ?? ""));
        return;
    }
  }

  private data(f: Uint8Array): void {
    if (f.byteLength < 5) return;
    const id = new DataView(f.buffer, f.byteOffset).getUint32(1);
    const s = this.streams.get(id);
    if (!s) return;
    const payload = f.subarray(5);
    let flowing = true;
    if (f[0] === DATA && s.req) {
      if (s.left !== undefined) {
        s.left -= payload.byteLength;
        if (s.left < 0) return this.fail(id, "body longer than its content-length");
      }
      flowing = s.req.write(payload);
    } else if (f[0] === WS_TEXT) flowing = s.origin?.send(1, Buffer.from(payload)) ?? true;
    else if (f[0] === WS_BINARY) flowing = s.origin?.send(2, Buffer.from(payload)) ?? true;
    // The relay socket can't be paused, so the stream whose origin is furthest behind pays, not the process.
    if (flowing || this.queued() <= MAX_QUEUED) return;
    const [worst] = [...this.streams].reduce((x, y) => (queuedFor(y[1]) > queuedFor(x[1]) ? y : x));
    this.fail(worst, "origin reads too slowly");
  }

  private queued(): number {
    let n = 0;
    for (const s of this.streams.values()) n += queuedFor(s);
    return n;
  }

  private abort(id: number): void {
    const s = this.streams.get(id);
    this.streams.delete(id);
    s?.req?.destroy();
    s?.res?.destroy();
    s?.origin?.destroy();
  }

  private fail(id: number, message: string): void {
    if (!this.streams.has(id)) return;
    this.send({ t: "error", id, message });
    this.abort(id);
  }

  private open(m: Req): void {
    try {
      this.forward(m);
    } catch {
      // node:http refuses some values a public client can send (a header above U+00FF, an odd method).
      this.abort(m.id);
      this.answer(m.id, 400, "Bad request.\n");
    }
  }

  private answer(id: number, status: number, text: string): void {
    this.send({ t: "res", id, status, headers: [["content-type", "text/plain; charset=utf-8"]] });
    this.sendFrame(DATA, id, new TextEncoder().encode(text));
    this.send({ t: "end", id });
  }

  private forward(m: Req): void {
    const pathname = new URL(m.path, "http://relay").pathname;
    const origin = this.routes[pathname];
    if (!origin) return this.answer(m.id, 404, "No local route for this path.\n");
    const target = new URL(origin);
    const body = m.body && !m.ws;
    const headers = grouped(m.headers);
    const lengths = headers.get("content-length") ?? [];
    if (lengths.length && (lengths.length > 1 || headers.has("transfer-encoding") || !/^\d{1,15}$/.test(lengths[0]!))) {
      return this.answer(m.id, 400, "Bad request.\n");
    }
    // The connector frames the body itself, for every method: node:http leaves some methods' bodies unframed.
    headers.delete("transfer-encoding");
    headers.delete("expect"); // the body comes without waiting for a 100
    if (!body) headers.delete("content-length");
    else if (!lengths.length) headers.set("transfer-encoding", ["chunked"]);
    let key = "";
    if (m.ws) {
      key = randomBytes(16).toString("base64");
      headers.set("connection", ["Upgrade"]).set("upgrade", ["websocket"]).set("sec-websocket-version", ["13"]).set("sec-websocket-key", [key]);
    }
    const req = httpRequest({
      host: target.hostname.replace(/^\[(.*)\]$/, "$1"), // an IPv6 literal, without the URL's brackets
      port: Number(target.port) || 80,
      method: m.method,
      path: m.path,
      // node:http wants a lone value as a string, Host above all; two Hosts throw, and open() answers 400.
      headers: Object.fromEntries([...headers].map(([k, v]) => [k, v.length === 1 ? v[0]! : v])),
      setHost: false,
    });
    if (!body) {
      // Otherwise node:http adds its own framing to a POST that has no body.
      req.removeHeader("content-length");
      req.removeHeader("transfer-encoding");
    }
    const s: Stream = { req, left: body && lengths.length ? Number(lengths[0]) : undefined };
    this.streams.set(m.id, s);

    req.on("response", (res) => this.respond(m.id, s, res));
    req.on("upgrade", (res, socket, head) => {
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (!m.ws || res.headers["sec-websocket-accept"] !== accept) {
        socket.destroy();
        return this.fail(m.id, "bad upgrade");
      }
      s.req = undefined;
      s.origin = new OriginSocket(socket, head, {
        message: (op, payload) => {
          // Until the origin answers a close it can still send, perhaps after the relay socket reconnected.
          if (this.streams.get(m.id) !== s) return;
          this.sendFrame(op === 1 ? WS_TEXT : WS_BINARY, m.id, payload);
          this.backpressure(socket);
        },
        close: (code, reason) => {
          if (this.streams.delete(m.id)) this.send({ t: "ws_close", id: m.id, code: closeCode(code), reason });
        },
      });
      const protocol = res.headers["sec-websocket-protocol"];
      this.send({ t: "res", id: m.id, status: 101, headers: protocol ? [["sec-websocket-protocol", String(protocol)]] : [] });
    });
    req.on("error", () => this.fail(m.id, "origin unreachable"));
    if (!body) req.end();
  }

  private respond(id: number, s: Stream, res: IncomingMessage): void {
    if (!this.streams.has(id)) return void res.destroy();
    s.res = res;
    const headers: Pairs = [];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i]!.toLowerCase(), res.rawHeaders[i + 1]!]);
    this.send({ t: "res", id, status: res.statusCode ?? 502, headers });
    res.on("data", (chunk: Buffer) => {
      if (!this.streams.has(id)) return void res.destroy();
      this.sendFrame(DATA, id, chunk);
      this.backpressure(res);
    });
    res.on("end", () => {
      if (this.streams.delete(id)) this.send({ t: "end", id });
      // The origin answered before the body ended; the rest is dropped, so the socket can't be reused.
      if (s.req && !s.req.writableFinished) s.req.destroy();
    });
    res.on("error", () => this.fail(id, "origin response failed"));
  }

  private backpressure(from: Readable): void {
    const ws = this.ws;
    if (!ws || ws.bufferedAmount < HIGH_WATER || from.isPaused()) return;
    from.pause();
    const check = (): void => {
      if (this.ws !== ws || from.destroyed) return;
      if (ws.bufferedAmount < HIGH_WATER / 2) from.resume();
      else setTimeout(check, 10);
    };
    setTimeout(check, 10);
  }
}

/** Header values by lowercase name, in order. */
function grouped(pairs: Pairs): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of pairs) {
    const k = name.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), value]);
  }
  return out;
}

/** The close code to pass on for `code`: no status is 1000, and one that can't go on the wire is 1011. */
function closeCode(code: number): number {
  if (code === 1005) return 1000;
  const pass = code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return pass ? code : 1011;
}

/** `reason` cut to the 123 UTF-8 bytes a close frame holds, at a character boundary. */
function closeReason(reason: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(reason).subarray(0, 123), { stream: true });
}

interface OriginEvents {
  message: (op: number, payload: Buffer) => void;
  close: (code: number, reason: string) => void;
}

function queuedFor(s: Stream): number {
  return (s.req?.writableLength ?? 0) + (s.origin?.queued ?? 0);
}

/**
 * The client end of an RFC 6455 WebSocket on an upgraded socket: masked frames
 * out, fragments joined, pings answered, close handshake. No extensions.
 */
class OriginSocket {
  /** Bytes read and not parsed yet: joined only once the next frame is whole. */
  private chunks: Buffer[] = [];
  private have = 0;
  private need = 2;
  private parts: Buffer[] = [];
  private size = 0;
  private op = 0;
  private closeSent = false;
  private closed = false;

  private readonly socket: Duplex;
  private readonly on: OriginEvents;

  constructor(socket: Duplex, head: Buffer, on: OriginEvents) {
    this.socket = socket;
    this.on = on;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("close", () => this.gone(1006, ""));
    socket.on("error", () => socket.destroy());
    if (head.length) {
      this.chunks = [head];
      this.have = head.length;
      queueMicrotask(() => this.parse());
    }
  }

  get queued(): number {
    return this.socket.writableLength;
  }

  /** False when the origin is behind, as in stream.write(). */
  send(op: number, payload: Buffer): boolean {
    if (this.closeSent || this.closed) return true;
    return this.write(op, payload);
  }

  close(code: number, reason: string): void {
    if (this.closeSent || this.closed) return;
    const r = Buffer.from(closeReason(reason));
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(closeCode(code));
    r.copy(body, 2);
    this.write(8, body);
    this.closeSent = true;
    setTimeout(() => this.socket.destroy(), 5000).unref();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private write(op: number, payload: Buffer): boolean {
    const len = payload.length;
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    return this.socket.write(Buffer.concat([head, mask, body]));
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.have += chunk.length;
    this.parse();
  }

  private parse(): void {
    while (!this.closed && this.have >= this.need) {
      const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      this.chunks = [buf];
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      let len = b1 & 0x7f;
      const off = len === 126 ? 4 : len === 127 ? 10 : 2;
      this.need = off;
      if (buf.length < off) return;
      if (len === 126) len = buf.readUInt16BE(2);
      else if (len === 127) len = Number(buf.readBigUInt64BE(2));
      const joined = (b0 & 0x0f) === 0 ? this.size : 0;
      if (joined + len > MAX_MESSAGE) return this.tooBig();
      const masked = (b1 & 0x80) !== 0;
      const at = off + (masked ? 4 : 0);
      this.need = at + len;
      if (buf.length < this.need) return;
      let payload = buf.subarray(at, at + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]!));
      }
      const rest = buf.subarray(at + len);
      this.chunks = rest.length ? [rest] : [];
      this.have = rest.length;
      this.need = 2;
      this.frame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  private frame(fin: boolean, op: number, payload: Buffer): void {
    if (op === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.subarray(2).toString("utf8");
      if (!this.closeSent) this.close(code, reason);
      this.socket.end();
      return this.gone(code, reason);
    }
    if (op === 9) return void this.send(10, payload);
    if (op === 10) return;
    if (op !== 0) {
      this.op = op;
      this.parts = [];
      this.size = 0;
    }
    this.size += payload.length;
    if (payload.length) this.parts.push(Buffer.from(payload));
    if (!fin) return;
    const message = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (this.op === 1 || this.op === 2) this.on.message(this.op, message);
  }

  private tooBig(): void {
    this.chunks = [];
    this.parts = [];
    this.close(1009, "message too big");
    this.socket.end(() => this.socket.destroy());
    this.gone(1009, "message too big");
  }

  private gone(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.on.close(code, reason);
  }
}
