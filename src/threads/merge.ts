/**
 * How a side panel chat and its copy in the Local Studio app are compared and put together. Pure: the worker, the panel,
 * the native host and the tests share it. A message keeps its time on both sides, which is how both know it.
 */

export interface SessionMessage {
	role: "user" | "assistant" | "toolResult";
	content: unknown[];
	timestamp: number;
	toolCallId?: string;
	[field: string]: unknown;
}

type Loose = Record<string, unknown>;

export const isRecord = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
export const timeOf = (m: Loose): number | undefined =>
	typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : undefined;
export const roleOf = (m: Loose): SessionMessage["role"] | undefined =>
	m.role === "user-with-attachments"
		? "user"
		: m.role === "user" || m.role === "assistant" || m.role === "toolResult"
			? m.role
			: undefined;

/** A message's name on both sides, or undefined for one that only the panel keeps. */
export function messageKey(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const role = roleOf(message);
	const time = timeOf(message);
	if (!role || time === undefined) return undefined;
	return role === "toolResult" ? `${role}:${time}:${String(message.toolCallId ?? "")}` : `${role}:${time}`;
}

/** Every message's key in order; a second message of one role in one millisecond gets "#2". */
export function messageKeys(messages: readonly unknown[]): (string | undefined)[] {
	const seen = new Map<string, number>();
	return messages.map((m) => {
		const key = messageKey(m);
		if (key === undefined) return undefined;
		const n = (seen.get(key) ?? 0) + 1;
		seen.set(key, n);
		return n === 1 ? key : `${key}#${n}`;
	});
}

/**
 * The chat with the app's messages put in, once each and nothing dropped. Both sides are split into turns (a user message
 * and what follows it): a turn the app added goes after the last turn here that started at or before it, and an answer
 * the app added goes to the end of the turn it answers.
 */
export function mergeTurns<T>(here: readonly T[], app: readonly SessionMessage[]): (T | SessionMessage)[] {
	interface Turn {
		at: number;
		messages: (T | SessionMessage)[];
	}
	const hereKeys = messageKeys(here);
	const appKeys = messageKeys(app);
	const have = new Set(hereKeys);
	const turns: Turn[] = [{ at: -Infinity, messages: [] }];
	const byUser = new Map<string, Turn>();
	here.forEach((m, i) => {
		const key = hereKeys[i];
		if (key !== undefined && roleOf(m as Loose) === "user") {
			const turn: Turn = { at: timeOf(m as Loose) as number, messages: [m] };
			turns.push(turn);
			byUser.set(key, turn);
		} else turns[turns.length - 1].messages.push(m);
	});
	let turn: Turn | undefined;
	app.forEach((m, i) => {
		const key = appKeys[i];
		if (key === undefined) return;
		if (have.has(key)) {
			turn = m.role === "user" ? byUser.get(key) : turn;
			return;
		}
		if (m.role === "user" || !turn) {
			// After every turn that started at or before it, and before the next.
			let at = turns.length;
			while (at > 1 && turns[at - 1].at > m.timestamp) at--;
			turn = { at: m.timestamp, messages: [m] };
			turns.splice(at, 0, turn);
		} else turn.messages.push(m);
	});
	return turns.flatMap((t) => t.messages);
}
