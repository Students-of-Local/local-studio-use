import { RELEASE_REPO, SOURCE_URL } from "./release-source.js";

/** Where `local-studio-browser install --release` puts the program it runs from. A release install adds nothing to PATH. */
const RELEASE_PROGRAM = "~/.local/share/local-studio-browser/release/local-studio-browser";

/**
 * A prompt the user pastes into their own agent (Claude Code, Codex, pi, OMP, OpenCode,
 * Cursor, ...). The agent installs the helper (the Local Studio app's own, or a source build) and connects the MCP
 * server.
 * Plain steps only: no piped installers, and nothing that asks for a key or password.
 */
export function agentSetupPrompt(version: string): string {
	const command = "local-studio-browser";
	// Without the version the install can't be pinned, so refuse rather than copy a broken prompt.
	if (!/^\d+\.\d+\.\d+/.test(version))
		throw new Error(`No extension version to pin the helper to (got "${version}").`);
	return `Set up Local Studio's browser use (${SOURCE_URL}) so you can use my browser. Its browser extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix.

1. Note the directory you started in, then check that git is installed: pwd && git --version
   Remember the directory pwd printed: it is my project.
2. Install the helper that matches the extension.
   - If ${command} --version prints ${version} and ${command} doctor reports no problems with the helper or the build, skip the rest of this step and go to step 3.
   - If the Local Studio app is on this computer and its Settings has Browser use, ask me to turn that on and wait until I say it is done, then go to step 5.
   - Otherwise build it from source. It needs Node 22 or newer: node -v
     If ~/local-studio-src exists: cd into it. If git status shows any local change, stop and ask me. With a clean checkout, run git fetch --depth 1 origin main && git checkout --detach FETCH_HEAD.
     If it doesn't exist: git clone --depth 1 https://github.com/${RELEASE_REPO} ~/local-studio-src && cd ~/local-studio-src
     Then: cd browser && ./scripts/setup-siblings.sh && npm run build && (cd cli && npm run build && npm link)
     If npm link fails with a permissions error, run "node ~/local-studio-src/browser/cli/dist/index.js" in place of "${command}" in every command below.
3. Run: ${command} setup --yes
   It registers the browser connection and adds the MCP server to Claude Code and Codex.
4. Connect this harness, even if Local Studio's browser use already works in another one:
   - Any MCP client: a stdio server named "local-studio" that runs the full path of the command you use with the argument "mcp". JSON configs need the full path, not ~.
   - pi has no MCP client: run ${command} pi-extension instead.
5. Run ${command} doctor and fix anything it reports with the command it prints.
6. Restart or reload MCP servers if this harness needs it, then call the status tool of the MCP server named local-studio. Tell me whether it says connected.

${CLOSING}`;
}

const CLOSING = "Don't ask me for API keys or passwords. Local Studio doesn't need them for this.";

/**
 * A prompt for an agent on the computer that should be reachable from claude.ai, ChatGPT or
 * grok.com: set up the public route, then print a one-time approval code. Setup runs with
 * --no-passcode, so no long-lived passcode is made or printed into the agent's output, and the
 * prompt pipes nothing into a shell.
 */
export function remoteSetupPrompt(version: string, command = "local-studio-browser"): string {
	if (!/^\d+\.\d+\.\d+/.test(version))
		throw new Error(`No extension version to pin the helper to (got "${version}").`);
	return `Set up Local Studio's browser use (${SOURCE_URL}) so claude.ai, ChatGPT or grok.com can use my browser through my own computer. Its browser extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix. Nothing here costs money, and every route runs on my own accounts.

1. Run: ${command} doctor
   If ${command} isn't found, try ${RELEASE_PROGRAM} doctor, and use that full path in place of "${command}" in every command below. If neither runs, stop and tell me to copy the setup prompt from Settings > Agents in Local Studio's side panel and run that first.
2. Pick the route. If it isn't clear from what I told you, ask me which one:
   - One computer, no domain needed (the usual pick): a relay on my own free Cloudflare account, with Node.js 22 or later. Cloudflare's sign-in opens in my browser, so ask me to run ${command} remote setup --no-passcode in my own terminal, and wait until I say it finished
   - One computer with Tailscale installed and signed in: ${command} remote setup --tailscale --no-passcode
   - Several computers behind one address, on an always-on machine with an HTTPS address I already own: ${command} hub setup --public-url https://ADDRESS --no-passcode (with my address in place of ADDRESS)
   If a command stops and names a reason, show me the reason and the fix it names. Don't work around it.
3. --no-passcode makes no long-lived passcode, so setup prints none. Don't run ${command} token passcode yourself. If a passcode shows up in any output anyway, don't repeat it, write it to a file or put it in a message: tell me, and I will replace it with ${command} token passcode in my own terminal. I can also choose a passcode there later; the one-time code in step 4 is enough for now.
4. Run: ${command} token approval-code
   Show me the code and the connector URL it prints (the URL ends in /mcp). The code works once, for 10 minutes.
5. Run ${command} remote status (${command} hub status on a hub) and tell me what each line says.
6. Tell me to add the connector URL as a custom connector in claude.ai (Settings > Connectors), ChatGPT (Settings > Apps & Connectors) or grok.com (grok.com/connectors), and to type the code on the approval page when it asks.

${CLOSING}`;
}

/** The hub origin and code a device prompt may carry; anything else would let a stray string become a command. */
export const HUB_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[::1\])(?::\d{1,5})?$/;
export const CONNECT_CODE = /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * A prompt for an agent on another device: link it to this hub with a one-time connect code. That device may have
 * `local-studio-browser` on PATH (an npm link), or only the release program, so the prompt does not carry
 * this helper's name: the agent finds out which one runs there and uses it for every later step.
 */
export function deviceSetupPrompt(version: string, hubUrl: string, code: string): string {
	if (!/^\d+\.\d+\.\d+/.test(version))
		throw new Error(`No extension version to pin the helper to (got "${version}").`);
	if (!HUB_ORIGIN.test(hubUrl)) throw new Error("The hub address must be an origin like https://hub.example.com.");
	if (!CONNECT_CODE.test(code)) throw new Error("The connect code must look like TK-XXXX-XXXX.");
	return `Connect this computer's browser to my Local Studio hub at ${hubUrl}, so claude.ai, ChatGPT or grok.com can use it through my one connector. Local Studio's browser extension ${version} should already be loaded in my browser on this computer. Run each step yourself and show me any output you can't fix.

1. Find the command that runs the Local Studio helper on this computer. Run: local-studio-browser doctor
   If that says the command isn't found, run: ${RELEASE_PROGRAM} doctor
   Use the first one that runs, and write it as HELPER in every step below: HELPER is exactly "local-studio-browser" or "${RELEASE_PROGRAM}". If neither runs, stop and tell me to copy the setup prompt from Settings > Agents in Local Studio's side panel and run that first.
2. Run: HELPER link ${hubUrl} --code ${code}
   The code works once and expires 10 minutes after I copied this prompt. If the hub refuses it, tell me to get a new one in Settings > Connections > Add a device.
3. Run: HELPER link status
   Tell me whether it says connected.

${CLOSING}`;
}
