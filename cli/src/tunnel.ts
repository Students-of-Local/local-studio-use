/**
 * `local-studio-browser tunnel`: reach `local-studio-browser serve` from another device or a cloud agent through a
 * tunnel the user owns, which terminates TLS. Nothing is exposed until the user runs one.
 *
 * - tailscale: `tailscale serve` publishes https://<this machine>.<tailnet>.ts.net/local-studio-browser
 *   to the user's own tailnet only. `--public` uses `tailscale funnel` instead, which is
 *   reachable from the internet; the token is then the only lock, so it warns.
 * - cloudflare: a `cloudflared` quick tunnel (no account) gives a random https://*.trycloudflare.com URL that changes
 *   each time. It is for local testing with a token only: quick tunnels don't carry SSE, so claude.ai, ChatGPT and grok.com
 *   can't use one (docs/decisions.md, D30). For those, `remote setup` (cloudflare.ts for a named tunnel). Local Studio never makes accounts.
 *
 * Both tools are found the way `remote setup` finds them: on PATH, the Tailscale Mac app's own copy, and the cloudflared
 * Local Studio downloaded. This command downloads nothing.
 */

import { COMMAND_NAME } from "./self.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudflaredBinary } from "./cloudflare.ts";
import { tailscaleBinary } from "./tailscale.ts";
import { envVar } from "./env.ts";
import { configDir } from "./files.ts";
import { windowsProcessImage } from "./tool-paths.ts";

export const DEFAULT_PORT = 8787;
const SERVE_PATH = "/local-studio-browser";

function run(cmd: string, args: string[]): { code: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface TunnelResult {
	url?: string;
	message: string;
	ok: boolean;
}

/** What port 443 serves here, or undefined when Tailscale's answer can't be read. */
function servedOn443(bin: string): [string, { Proxy?: string }][] | undefined {
	try {
		const web = (JSON.parse(run(bin, ["serve", "status", "--json"]).out || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {};
		return Object.entries(web)
			.filter(([hostPort]) => hostPort.endsWith(":443"))
			.flatMap(([, v]) => Object.entries(v.Handlers ?? {}));
	} catch {
		return undefined;
	}
}

/** Turns off what serve publishes. Tailscale refuses to turn off what isn't there, which is the state asked for. */
function tailscaleOff(bin: string, mode: string): TunnelResult {
	const handlers = servedOn443(bin);
	const r = run(bin, [mode, "--https=443", `--set-path=${SERVE_PATH}`, "off"]);
	if (r.code === 0) return { ok: true, message: `Stopped the Tailscale ${mode} for ${SERVE_PATH}.` };
	if (handlers?.some(([path]) => path === SERVE_PATH) ?? true) return { ok: false, message: r.out };
	return { ok: true, message: "Nothing of the helper's was published on Tailscale." };
}

export function tailscaleTunnel(options: { port: number; public: boolean; off: boolean }): TunnelResult {
	const bin = tailscaleBinary();
	if (!bin) return { ok: false, message: "Tailscale isn't installed. Install it from tailscale.com and sign in, then run this again." };
	const mode = options.public ? "funnel" : "serve";
	if (options.off) {
		return tailscaleOff(bin, mode);
	}
	const status = run(bin, ["status", "--json"]);
	let dns = "";
	try {
		dns = String((JSON.parse(status.out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		/* reported below */
	}
	if (!dns) return { ok: false, message: "Tailscale isn't connected. Run tailscale up, then try again." };
	// Read the current serve config first and fail closed: changing serve without knowing
	// whether Funnel is on for :443 could make this path public by surprise.
	const statusRun = spawnSync(bin, ["serve", "status", "--json"], { encoding: "utf8", timeout: 30_000 });
	let status443: { AllowFunnel?: Record<string, boolean> } | undefined;
	try {
		if (statusRun.status === 0) status443 = JSON.parse(statusRun.stdout || "{}");
	} catch {
		status443 = undefined;
	}
	if (!status443 || typeof status443 !== "object") return { ok: false, message: "Couldn't read tailscale serve status, so nothing was changed." };
	if (!options.public && Object.entries(status443.AllowFunnel ?? {}).some(([hostPort, on]) => on && hostPort.endsWith(":443"))) {
		return {
			ok: false,
			message: `Funnel is on for port 443 on this machine, so ${SERVE_PATH} would be public, not tailnet-only. Nothing was changed. Use --public if that's what you want, or turn Funnel off for port 443 in Tailscale first.`,
		};
	}
	const read = servedOn443(bin);
	if (!read && options.public) return { ok: false, message: "Couldn't read tailscale serve status; not turning on Funnel." };
	const handlers = read ?? [];
	if (options.public) {
		// Funnel opens a whole host:port to the internet, not one path: refuse if anything else is served there.
		const others = handlers.map(([path]) => path).filter((path) => path !== SERVE_PATH);
		if (others.length) {
			return { ok: false, message: `Port 443 also serves ${others.join(", ")} on this machine. Funnel would make those public too, so it wasn't turned on.` };
		}
	}
	const r = run(bin, [mode, "--bg", "--yes", "--https=443", `--set-path=${SERVE_PATH}`, `http://127.0.0.1:${options.port}`]);
	if (r.code !== 0) return { ok: false, message: r.out };
	const url = `https://${dns}${SERVE_PATH}/mcp`;
	const reach = options.public ? "anyone on the internet who has a token" : "your own tailnet devices that have a token";
	return { ok: true, url, message: `MCP is reachable at ${url} by ${reach}. Run ${COMMAND_NAME} serve on port ${options.port}.` };
}

function cloudflaredPidFile(): string {
	return join(configDir(), "cloudflared.pid");
}

/** The cloudflared this command started, if it is still that process (not a reused PID); "unknown" when it can't be checked. */
export function ourCloudflared(platform: NodeJS.Platform = process.platform, exec = run): number | "unknown" | undefined {
	if (!existsSync(cloudflaredPidFile())) return undefined;
	const pid = Number(readFileSync(cloudflaredPidFile(), "utf8"));
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	if (platform === "win32") {
		// Windows has no ps; tasklist names the program, so a pid Windows has reused for something else reads as not running.
		const image = windowsProcessImage(pid, exec);
		return image === "unknown" ? image : image?.toLowerCase() === "cloudflared.exe" ? pid : undefined;
	}
	const ps = existsSync("/bin/ps") ? "/bin/ps" : "ps";
	const raw = spawnSync(ps, ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 10_000 });
	// Couldn't run ps at all: the process can't be checked, which is not the same as "not ours".
	if (raw.error || raw.status === null) return "unknown";
	const check = { code: raw.status, out: `${raw.stdout ?? ""}`.trim() };
	return /cloudflared/.test(check.out) && /tunnel/.test(check.out) && /--url http:\/\/127\.0\.0\.1:/.test(check.out) ? pid : undefined;
}

export async function cloudflareTunnel(options: { port: number; off: boolean; timeoutMs?: number }): Promise<TunnelResult> {
	if (options.off) {
		const pid = ourCloudflared();
		if (pid === "unknown") {
			return { ok: false, message: `Can't check which process ${cloudflaredPidFile()} names on this system. Stop cloudflared yourself, then delete that file.` };
		}
		rmSync(cloudflaredPidFile(), { force: true });
		if (pid === undefined) return { ok: true, message: "No Cloudflare tunnel started by the helper is running." };
		try {
			process.kill(pid);
		} catch {
			/* already gone */
		}
		return { ok: true, message: "Stopped the Cloudflare tunnel." };
	}
	if (ourCloudflared() !== undefined) return { ok: false, message: `A Cloudflare tunnel is already running. Run ${COMMAND_NAME} tunnel cloudflare --off first.` };
	const bin = cloudflaredBinary();
	if (!bin) {
		return {
			ok: false,
			message: `cloudflared isn't installed. A quick tunnel is for local testing with a token; claude.ai, ChatGPT and grok.com can't use one. For them, run ${COMMAND_NAME} remote setup: its default relay needs no cloudflared.`,
		};
	}
	mkdirSync(configDir(), { recursive: true });
	const log = join(configDir(), "cloudflared.log");
	writeFileSync(log, "");
	const fd = openSync(log, "a");
	const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`], { detached: true, stdio: ["ignore", fd, fd] });
	child.unref();
	if (child.pid) writeFileSync(cloudflaredPidFile(), String(child.pid));
	const deadline = Date.now() + (options.timeoutMs ?? (Number(envVar("TUNNEL_TIMEOUT_MS")) || 30_000));
	while (Date.now() < deadline) {
		// The issued name, never api.trycloudflare.com from an error line.
		const m = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(readFileSync(log, "utf8"));
		if (m) return { ok: true, url: `${m[0]}/mcp`, message: `MCP is reachable at ${m[0]}/mcp by anyone who has a token, for local testing. claude.ai, ChatGPT and grok.com can't use a quick tunnel (it doesn't carry their event stream, and the address changes each time); for them, run ${COMMAND_NAME} remote setup.` };
		await new Promise((r) => setTimeout(r, 250));
	}
	// No URL in time: stop it, so nothing is left exposed without the user knowing the address.
	try {
		if (child.pid) process.kill(child.pid);
	} catch {
		/* already gone */
	}
	rmSync(cloudflaredPidFile(), { force: true });
	return { ok: false, message: `cloudflared printed no URL in time, so it was stopped. See ${log}.` };
}
