/**
 * The relay route (remote.json `route: "relay"`): a public https://<name>.<subdomain>.workers.dev address on the person's own free
 * Cloudflare account, with no domain and nothing listening on this machine. The relay Worker comes from baney75/local-studio-tunnels
 * (relay/); the vendored client (relay-client.ts) dials it from here and carries serve's paths to 127.0.0.1:<port>.
 * `remote relay run` is what the relay service runs, the way `remote cloudflare run` runs cloudflared.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./files.ts";
import { RelayClient, type RelayState } from "./relay-client.ts";
import { WRANGLER_VERSION } from "./relay-setup.ts";
import { loadRemoteConfig, type RelayConfig, type RemoteConfig } from "./remote-config.ts";
import { LOCAL_STUDIO_BROWSER_PATHS } from "./route-record.ts";
import { COMMAND_NAME } from "./self.ts";
import { type ServiceSpec, writeAtomic } from "./service.ts";

export type { RelayState } from "./relay-client.ts";

export const RELAY_SERVICE: ServiceSpec = {
	label: "com.localstudio.browser.relay",
	unit: "local-studio-browser-relay.service",
	args: ["remote", "relay", "run"],
	logName: "local-studio-browser-relay.log",
	description: "Local Studio's Cloudflare relay connector",
	off: `${COMMAND_NAME} remote off`,
	kept: "remote.json",
};

/** serve's health check: the path setup asks for through the relay to prove a request reaches serve and comes back. */
export const HEALTH_PATH = "/v1/health";

/** The command that sets a relay up again with its saved name: a new key, and the Worker this version speaks to. */
export const relaySetupCommand = (name: string, account?: string): string => `${COMMAND_NAME} remote setup --relay ${name}${account ? ` --account ${account}` : ""}`;

/** That a relay's Worker outlives the setup on this computer, on which account, and the command that deletes it. */
export function workerStays({ name, accountId }: RelayConfig): string {
	const env = accountId && process.platform !== "win32" ? `CLOUDFLARE_ACCOUNT_ID=${accountId} ` : "";
	return `The relay Worker ${name} stays on your Cloudflare account${accountId ? ` ${accountId}` : ""}; a computer that still has its key can connect until you delete it: ${env}npx wrangler@${WRANGLER_VERSION} delete ${name}`;
}

/** RELAY_KEY: 32 bytes from the OS random source, base64url without padding (43 characters), as the relay requires. */
export function generateRelayKey(): string {
	return randomBytes(32).toString("base64url");
}

/** What the client forwards, and where: serve's nine paths and its health check, all to serve on loopback. Nothing else. */
export function relayRoutes(port: number): Record<string, string> {
	const origin = `http://127.0.0.1:${port}`;
	return Object.fromEntries([...LOCAL_STUDIO_BROWSER_PATHS, HEALTH_PATH].map((path) => [path, origin]));
}

/** The connector's last state, which `remote relay run` writes for `remote status` and the side panel. Never holds the key. */
export interface RelayStatus {
	state: RelayState;
	/** ms since 1970, when this state began. */
	at: number;
	/** The process that wrote it. A reader that finds it gone reads `stopped`. */
	pid: number;
}

export const relayStateFile = () => join(configDir(), "relay-state.json");

const RELAY_STATES: readonly RelayState[] = ["connecting", "connected", "disconnected", "replaced", "unauthorized", "outdated", "stopped"];

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists and belongs to someone else, which a service of ours never does, but it is alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** The connector's state, or undefined when it never ran. A state whose process is gone reads `stopped`. */
export function readRelayStatus(file: string = relayStateFile()): RelayStatus | undefined {
	if (!existsSync(file)) return undefined;
	let raw: Partial<RelayStatus>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RelayStatus>;
	} catch {
		return undefined;
	}
	if (!raw || !RELAY_STATES.includes(raw.state as RelayState) || typeof raw.at !== "number" || typeof raw.pid !== "number") return undefined;
	const status = { state: raw.state as RelayState, at: raw.at, pid: raw.pid };
	return status.state !== "stopped" && !alive(status.pid) ? { ...status, state: "stopped" } : status;
}

/** One line per state for the service's log, and what the person does about the states the client stops retrying in. */
const STATE_LINES: Record<RelayState, string> = {
	connecting: "Connecting to the relay.",
	connected: "Connected: the relay carries requests to serve.",
	disconnected: "Disconnected; trying again with backoff.",
	replaced: `Another connector with this key took over, on another computer or this one. Run ${COMMAND_NAME} remote fix where the relay should run.`,
	unauthorized: `The relay refused the key. Run ${COMMAND_NAME} remote fix.`,
	outdated: `The relay speaks another protocol version. Update ${COMMAND_NAME}, then run ${COMMAND_NAME} remote fix.`,
	stopped: "Stopped.",
};

export interface RelayRunOptions {
	config?: RemoteConfig;
	/** Where the state goes; tests pass their own. */
	stateFile?: string;
	log?: (line: string) => void;
	/** Resolves to stop the connector, in place of SIGTERM and SIGINT. */
	until?: Promise<void>;
}

/**
 * What the relay service runs: the connector in the foreground until SIGTERM or SIGINT. It never exits on its own in a state the
 * client stops retrying in (unauthorized, replaced, outdated), so the service manager doesn't restart it into the same answer over
 * and over; the state file says why, and setup again is the fix. 1 when remote.json isn't on the relay route.
 */
export async function runRelay(options: RelayRunOptions = {}): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(`[${COMMAND_NAME} relay] ${line}`));
	let config: RemoteConfig | undefined;
	try {
		config = options.config ?? loadRemoteConfig();
	} catch (err) {
		log(err instanceof Error ? err.message : String(err));
		return 1;
	}
	if (config?.route !== "relay" || !config.relay) {
		log(`remote.json isn't on the relay route. Run ${COMMAND_NAME} remote setup.`);
		return 1;
	}
	if (typeof WebSocket !== "function") {
		log(`The relay needs Node.js 22 or later (it has the built-in WebSocket); this is ${process.version}.`);
		return 1;
	}
	const file = options.stateFile ?? relayStateFile();
	const write = (state: RelayState) => {
		log(STATE_LINES[state]);
		try {
			writeAtomic(file, `${JSON.stringify({ state, at: Date.now(), pid: process.pid } satisfies RelayStatus)}\n`, 0o600);
		} catch (err) {
			// A full disk costs `remote status` its answer, never the connection.
			log(`Couldn't save the state in ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const client = new RelayClient({ url: config.publicUrl, key: config.relay.key, routes: relayRoutes(config.port), onState: write });
	const stop =
		options.until ??
		new Promise<void>((resolve) => {
			for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
		});
	log(`Relay ${config.publicUrl} -> 127.0.0.1:${config.port}`);
	// A client that stopped retrying holds no socket or timer, so this keeps the process (and its state) up until it is stopped.
	const hold = setInterval(() => {}, 2 ** 30);
	try {
		client.start();
		await stop;
		client.stop();
	} finally {
		clearInterval(hold);
	}
	return 0;
}
