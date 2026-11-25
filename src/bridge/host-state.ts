/**
 * Whether Local Studio's helper (the native host) answers, for the screens that tell someone without it how to install it.
 * The background worker (native.ts) writes it to chrome.storage.session: true once a host has talked on the port,
 * false when the port closes and when the worker starts. Screens watch it, so they change the moment the helper
 * connects, with no reload.
 */
export const HOST_CONNECTED_KEY = "local-studio.hostConnected";

/** Calls `onChange` with the current state, then on every change. Returns the function that stops watching. */
export function watchHostConnected(onChange: (connected: boolean) => void): () => void {
	let changed = false;
	const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area !== "session" || !(HOST_CONNECTED_KEY in changes)) return;
		changed = true;
		onChange(changes[HOST_CONNECTED_KEY].newValue === true);
	};
	chrome.storage.onChanged.addListener(listener);
	void chrome.storage.session
		.get(HOST_CONNECTED_KEY)
		.then((stored) => {
			// A change that arrived first is newer than what this read saw.
			if (!changed) onChange(stored[HOST_CONNECTED_KEY] === true);
		})
		.catch(() => {
			if (!changed) onChange(false);
		});
	return () => chrome.storage.onChanged.removeListener(listener);
}

/** Whether the helper answers right now. */
export async function hostConnected(): Promise<boolean> {
	const stored = await chrome.storage.session.get(HOST_CONNECTED_KEY);
	return stored[HOST_CONNECTED_KEY] === true;
}
