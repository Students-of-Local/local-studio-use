// Shared task site for the Local Studio study and the blind council rerun.
// Two origins from one process: A (main) and B (cross-origin frames). Pages POST what the task
// changed to /__done; the runner reads it back with GET /__state?task=ID. No tool sees the check.
//
//   node tasks/server.mjs [--port 4600] [--port2 4601]
//   import { startSite } from "./server.mjs"  ->  { origin, origin2, state(id), reset(), stop() }
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");

export async function startSite({ port = 0, port2 = 0 } = {}) {
	const done = new Map(); // task id -> last posted state
	const secrets = new Map(); // per-run values a tool must read, not guess
	const fresh = () => {
		secrets.set("voucher", `VX-${randomBytes(2).toString("hex").toUpperCase()}`);
		secrets.set("phrase", `amber-falcon-${10 + (randomBytes(1)[0] % 89)}`);
	};
	fresh();
	let origin = "";
	let origin2 = "";
	const handler = (self) => (req, res) => {
		const url = new URL(req.url, "http://x");
		const path = url.pathname;
		const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
		if (req.method === "OPTIONS") {
			res.writeHead(204, cors);
			return res.end();
		}
		if (req.method === "POST" && path === "/__done") {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				try {
					const msg = JSON.parse(body);
					done.set(msg.task, { ...msg, at: Date.now() });
				} catch {}
				res.writeHead(204, cors);
				res.end();
			});
			return;
		}
		if (path === "/__state") {
			res.writeHead(200, { "content-type": "application/json", ...cors });
			return res.end(JSON.stringify(done.get(url.searchParams.get("task")) ?? null));
		}
		if (path === "/__secret") {
			res.writeHead(200, { "content-type": "application/json", ...cors });
			return res.end(JSON.stringify(secrets.get(url.searchParams.get("k")) ?? null));
		}
		if (path === "/" || path === "/index.html") {
			const ids = readdirSync(siteDir).filter((d) => /^t\d\d-/.test(d)).sort();
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(`<!doctype html><title>Task site</title><h1>Task site</h1><ul>${ids.map((i) => `<li><a href="/${i}/">${i}</a></li>`).join("")}</ul>`);
		}
		let file = join(siteDir, path.endsWith("/") ? `${path}index.html` : path);
		if (!file.startsWith(siteDir) || !existsSync(file)) {
			if (existsSync(`${file}.html`)) file = `${file}.html`;
			else {
				res.writeHead(404, { "content-type": "text/plain" });
				return res.end("not found");
			}
		}
		const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
		let body = readFileSync(file, "utf8");
		body = body
			.replaceAll("{{origin2}}", self === "a" ? origin2 : origin)
			.replaceAll("{{origin}}", self === "a" ? origin : origin2)
			.replaceAll("{{voucher}}", secrets.get("voucher"))
			.replaceAll("{{phrase}}", secrets.get("phrase"));
		res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
		res.end(body);
	};
	const a = createServer(handler("a"));
	const b = createServer(handler("b"));
	await new Promise((r) => a.listen(port, "127.0.0.1", r));
	await new Promise((r) => b.listen(port2, "127.0.0.1", r));
	origin = `http://127.0.0.1:${a.address().port}`;
	// The second origin is a different host name too, so it is cross-site, not only cross-port.
	origin2 = `http://localhost:${b.address().port}`;
	return {
		origin,
		origin2,
		state: (id) => done.get(id) ?? null,
		secret: (k) => secrets.get(k),
		reset: () => {
			done.clear();
			fresh();
		},
		stop: () => Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const arg = (n, d) => {
		const i = process.argv.indexOf(n);
		return i > 0 ? Number(process.argv[i + 1]) : d;
	};
	const s = await startSite({ port: arg("--port", 4600), port2: arg("--port2", 4601) });
	console.log(`task site: ${s.origin}  cross-origin: ${s.origin2}`);
}
