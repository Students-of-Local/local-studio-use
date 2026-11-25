/**
 * The sign-in window (static/sign-in.html): the user types the username and password an agent asked for, and they go to
 * the service worker in one message, which writes them into the page (src/handback/sign-in.ts has the whole path).
 */

import { SIGN_IN_MESSAGE, type SignInMessage, type SignInValues, signInWait } from "./sign-in.js";
import { HANDBACK_KEY, type PendingHandback } from "./state.js";

const id = location.hash.slice(1);
const at = <T extends HTMLElement>(name: string) => document.getElementById(name) as T;
const form = at<HTMLFormElement>("form");
const status = at("status");
const inputs = { username: at<HTMLInputElement>("username"), password: at<HTMLInputElement>("password") };
let sending = false;

function draw(wait: PendingHandback): void {
	const { signIn } = wait;
	if (!signIn) return;
	document.title = `Sign in to ${signIn.host}`;
	at("host").textContent = signIn.host;
	at("who").textContent = `${wait.agent} asks you to sign in to`;
	at("reason").textContent = wait.reason === "Your turn" ? "" : `It says: ${wait.reason}`;
	at("where").textContent =
		`This goes straight into the page, and no copy is kept. ${wait.agent} isn't given it, but it can see a username the page shows, and a script it runs there could read the fields.`;
	for (const what of ["username", "password"] as const) {
		const asked = !!signIn.fields[what];
		at(`${what}-row`).hidden = !asked;
		inputs[what].required = asked;
	}
	form.hidden = false;
	(signIn.fields.username ? inputs.username : inputs.password).focus();
}

function say(text: string): void {
	status.textContent = text;
}

/** The wait is over: nothing typed here goes anywhere any more. */
function end(text: string): void {
	for (const input of Object.values(inputs)) input.value = "";
	form.hidden = true;
	say(text);
}

async function send(message: SignInMessage): Promise<{ error?: string } | undefined> {
	return chrome.runtime.sendMessage(message);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (sending) return;
	sending = true;
	const values: SignInValues = {};
	for (const button of [at<HTMLButtonElement>("fill"), at<HTMLButtonElement>("cancel")]) button.disabled = true;
	say("Filling in...");
	for (const what of ["username", "password"] as const) if (inputs[what].required) values[what] = inputs[what].value;
	const reply = await send({ type: SIGN_IN_MESSAGE, id, action: "fill", values }).catch(() => ({
		error: "The extension didn't answer, so it isn't known what went in. Look at the page.",
	}));
	if (!reply?.error) return window.close();
	end(reply.error);
});

at("cancel").addEventListener("click", async () => {
	if (sending) return;
	sending = true;
	await send({ type: SIGN_IN_MESSAGE, id, action: "cancel" }).catch(() => undefined);
	window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "session" || !(HANDBACK_KEY in changes) || sending) return;
	void signInWait(id).then((wait) => {
		if (!wait && !sending) window.close();
	});
});

void signInWait(id).then((wait) => (wait ? draw(wait) : end("This sign-in is over. You can close this window.")));
