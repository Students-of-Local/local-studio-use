/**
 * remote.json: the route `remote setup` saved, which `serve` and the tunnel runner read. A leaf module, so cloudflare.ts can read it
 * without importing remote-setup.ts (which imports cloudflare.ts).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./files.ts";
import { readRouteRecord, validHostname } from "./route-record.ts";
import { COMMAND_NAME } from "./self.ts";
import { writeAtomic } from "./service.ts";

/**
 * route: funnel (Tailscale Funnel on 8443), custom (the person's own front door, or Local Studio's tunnel joined with `remote join`),
 * cloudflare (a named tunnel on their account), tailnet (`tailscale serve` on 443, their own tailnet only) or relay (a relay Worker
 * on their own free Cloudflare account, relay.ts). aliases: extra hostnames serve answers OAuth on, each as its own https origin,
 * while a connector moves from one name to publicUrl's.
 */
export interface RemoteConfig {
	publicUrl: string;
	port: number;
	route: "funnel" | "custom" | "cloudflare" | "tailnet" | "relay";
	redirectHosts?: string[];
	allowHosts?: string[];
	aliases?: string[];
	/** The relay route's Worker: its name on the account, and RELAY_KEY, the secret the connector presents. The file is 0600. */
	relay?: RelayConfig;
}

export interface RelayConfig {
	name: string;
	key: string;
	/** The Cloudflare account it was deployed to, when the sign-in has more than one. */
	accountId?: string;
}

export const REMOTE_ROUTES: readonly RemoteConfig["route"][] = ["funnel", "custom", "cloudflare", "tailnet", "relay"];

/** A Worker name: 1 to 63 of a-z, 0-9 and -, not starting or ending with -. It is the first label of the workers.dev address. */
export const validWorkerName = (name: string): boolean => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);

/** RELAY_KEY as the relay accepts it: base64url, at least 43 characters (32 random bytes). */
export const validRelayKey = (key: string): boolean => /^[A-Za-z0-9_-]{43,256}$/.test(key);

/** A Cloudflare account id: 32 hex digits. */
export const validAccountId = (id: string): boolean => /^[0-9a-f]{32}$/.test(id);

/** The relay block, checked. Messages name the field, never its value: the key must not reach a log. */
function relayConfig(value: unknown, file: string): RelayConfig | undefined {
	if (value === undefined) return undefined;
	const r = value as Record<string, unknown>;
	if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${file}: relay must be an object.`);
	if (typeof r.name !== "string" || !validWorkerName(r.name)) throw new Error(`${file}: relay.name must be a Worker name such as local-studio-browser-relay.`);
	if (typeof r.key !== "string" || !validRelayKey(r.key)) throw new Error(`${file}: relay.key isn't a relay key. Run ${COMMAND_NAME} remote setup again to make a new one.`);
	if (r.accountId !== undefined && (typeof r.accountId !== "string" || !validAccountId(r.accountId))) throw new Error(`${file}: relay.accountId must be a Cloudflare account id.`);
	return { name: r.name, key: r.key, ...(typeof r.accountId === "string" ? { accountId: r.accountId } : {}) };
}

export const remoteFile = () => join(configDir(), "remote.json");

const stringList = (value: unknown, field: string): string[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw new Error(`${remoteFile()}: ${field} must be a list of strings.`);
	return value as string[];
};

/**
 * remote.json (or `file`, another config folder's, such as the one a service was set up with), or undefined when it doesn't
 * exist. A file that exists but is wrong throws, so serve never silently drops it.
 */
export function loadRemoteConfig(file: string = remoteFile()): RemoteConfig | undefined {
	if (!existsSync(file)) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${file} isn't valid JSON. Run ${COMMAND_NAME} remote off to remove it, then ${COMMAND_NAME} remote setup again.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${file} isn't a Local Studio remote file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${file}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${file}: port must be a port number.`);
	if (!REMOTE_ROUTES.includes(raw.route as RemoteConfig["route"])) throw new Error(`${file}: route must be funnel, custom, cloudflare, tailnet or relay.`);
	const redirectHosts = stringList(raw.redirectHosts, "redirectHosts");
	const allowHosts = stringList(raw.allowHosts, "allowHosts");
	const aliases = stringList(raw.aliases, "aliases");
	if (aliases?.some((a) => !validHostname(a))) throw new Error(`${file}: aliases must be lowercase DNS names such as old.example.com.`);
	const relay = relayConfig(raw.relay, file);
	if (raw.route === "relay" && !relay) throw new Error(`${file}: the relay route needs its relay block. Run ${COMMAND_NAME} remote setup again.`);
	return {
		publicUrl: raw.publicUrl,
		port: raw.port,
		route: raw.route as RemoteConfig["route"],
		...(redirectHosts ? { redirectHosts } : {}),
		...(allowHosts ? { allowHosts } : {}),
		...(aliases?.length ? { aliases } : {}),
		...(relay ? { relay } : {}),
	};
}

/** Reached only from the tailnet: browser use's own tailnet route, or the app's tailnet route joined (its record's address and port). */
export function reachedOnTailnet(config: RemoteConfig): boolean {
	if (config.route !== "custom") return config.route === "tailnet";
	try {
		const record = readRouteRecord();
		return record?.owner === "local-studio" && record.route === "tailnet" && config.publicUrl === `https://${record.hostname}` && config.port === record.ports.mcp;
	} catch {
		return false;
	}
}

export function saveRemoteConfig(config: RemoteConfig): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeAtomic(remoteFile(), `${JSON.stringify(config, null, "\t")}\n`, 0o600);
}
