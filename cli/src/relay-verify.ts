/** The last step of `remote setup` on the relay route (relay.ts): that what was set up answers from the public address. */
import { HEALTH_PATH } from "./relay.ts";
import { sleep } from "./service.ts";
import { USER_AGENT } from "./version.ts";

export interface VerifySeam {
	fetch?: typeof fetch;
}

/**
 * The end-to-end check: the relay reports the connector, then GET /v1/health through it comes back from serve as {"ok":true}.
 * A new subdomain can take minutes to resolve and the connector a few seconds to dial, so it retries until `deadline`.
 */
export async function verify(url: string, deadline: number, every: number, seam: VerifySeam = {}): Promise<{ ok: true } | { ok: false; code: "relay_connector" | "relay_health"; message: string }> {
	const get = seam.fetch ?? fetch;
	const headers = { "user-agent": USER_AGENT };
	let last = "";
	let connected = false;
	for (;;) {
		try {
			// Asked every time: a connector that dropped after the first answer isn't serve's fault.
			connected = false;
			const relay = await get(`${url}/_relay/health`, { headers, signal: AbortSignal.timeout(10_000) });
			const said = (await relay.json().catch(() => undefined)) as { connected?: unknown } | undefined;
			connected = relay.ok && said?.connected === true;
			last = connected ? "" : relay.ok ? "the relay answers but no connector is connected" : `the relay answered ${relay.status}`;
			if (connected) {
				const res = await get(`${url}${HEALTH_PATH}`, { headers, signal: AbortSignal.timeout(10_000) });
				const body = (await res.json().catch(() => undefined)) as { ok?: unknown } | undefined;
				if (res.status === 200 && body?.ok === true) return { ok: true };
				last = `${HEALTH_PATH} through the relay answered ${res.status}${res.status === 200 ? ' without {"ok":true}' : ""}`;
			}
		} catch (err) {
			// fetch says only "fetch failed"; a name that doesn't resolve yet or a refused connection is in its cause.
			const { code, message } = (err instanceof Error ? (err.cause ?? err) : { message: String(err) }) as { code?: unknown; message?: unknown };
			last = String(code || message);
		}
		if (Date.now() + every > deadline) break;
		await sleep(every);
	}
	return connected
		? { ok: false, code: "relay_health", message: `The relay reaches this computer, but serve didn't answer ${HEALTH_PATH} through it (${last}).` }
		: { ok: false, code: "relay_connector", message: `The relay at ${url} didn't report this computer's connector (${last}).` };
}
