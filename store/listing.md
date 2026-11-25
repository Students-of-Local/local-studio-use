# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Reasons for each permission are in
[permissions.md](permissions.md). The images come from `node scripts/store-shots.mjs` (see its header).

Build the zip:

```bash
scripts/build-store.sh "$HOME/Downloads/tychicus-store"
```

It writes `tychicus-<version>-store.zip` (the version is `static/manifest.chrome.json`'s, which must equal
`package.json`'s). The build refuses a zip whose manifest has a `key`, a name other than Local Studio, a missing icon, or a
permission with no row in permissions.md.

## Order of the first upload

1. Build the zip and upload it as a draft. Don't submit it yet. Google assigns the store id.
2. Put that id in `STORE_EXTENSION_ID` in `cli/src/install.ts` (it is `""` now) and merge. That one constant is where
   the store id is pinned: the native host manifest `tychicus install` writes allows it (`extensionOrigins`), and the
   host refuses any other caller (`callerRefusal` in `cli/src/host.ts`). The unpacked copy's id stays
   `igjafcggmahiboobmnhfkndodphjdnhg` in `src/bridge/extension-id.json`, fixed by the manifest key the zip leaves out.
   `test/store-origins.test.mjs` covers both ids.
3. Release the helper from that commit with `./release.sh patch` (it tags `v<version>`, and
   `.github/workflows/release.yml` builds the helper with the id in it). People who installed before run the
   one install command again (or `tychicus install --release <folder>`), which rewrites the host manifest to allow
   the store copy. Until this step, a store copy finds no helper it may talk to: Chrome refuses the connection
   because the host manifest doesn't list its id, so its welcome screen keeps showing the install command.
4. Submit the draft for review.

## Store listing tab

**Title:** Local Studio

**Summary** (from the manifest's `description`, 132 characters at most):

```
Lets AI agents work in your browser, in their own tab group, while you keep working.
```

**Category:** Tools (Productivity)

**Language:** English

**Description:**

```
Local Studio lets an AI agent work in your browser while you keep working. The agent gets a tab group of its own and works there in the background: it opens pages, reads them, clicks, fills in forms and checks its own work, without taking focus from the tab you are using. Your tabs stay yours.

What it does well:

• Its own tab group. Each agent works in a group of its own tabs, marked while it works, with a pointer that shows what it is doing and a "Take over" button.
• Background tabs, no stolen focus. The agent acts in its tabs without bringing them to the front, so you can keep typing somewhere else.
• The agents you already use. Claude Code, Codex, Cursor, OpenCode, pi and any other MCP agent drive your browser through the free Local Studio helper on your computer. With the helper and your own Tailscale or Cloudflare tunnel, claude.ai, ChatGPT and grok.com can use it too.
• Local models through the Local Studio app. With the app on your computer, the side panel chats on your local models and the plans you signed in to there, with no API key or sign-in in the extension.
• Or bring an API key from Anthropic, OpenAI, Google, OpenRouter and others, or use a free OpenRouter key.

Set up the helper in one command. The welcome screen shows the one for your computer with a Copy button, and shows the helper connected as soon as it runs.

On macOS or Linux, in a terminal:
curl -fsSL https://github.com/baney75/tychicus/releases/latest/download/install.sh | sh

On Windows, in PowerShell:
irm https://github.com/baney75/tychicus/releases/latest/download/install.ps1 | iex

You stay in charge:

• You pick when agents ask. By default, agents on frontier models open ordinary sites, small or unknown models ask first, and every agent asks before it goes straight to mail, a bank or another sensitive site. Manual asks before an agent opens a new site. Where a clicked link or a redirect leads isn't checked. Allowed sites are listed in Settings, where you can remove them.
• It stops and hands the tab to you for sign-ins and captchas.
• Private mode sends prompts only to models that don't keep them, or to your own machines.

No account, no analytics, and open source under the AGPL-3.0. Local Studio runs no servers of its own. Your chats and settings stay on your computer, and your messages, and what the agent reads, go only to the AI you picked.

The browser tools come three ways: with the Local Studio app, as a helper you install on its own, and as this Chrome extension. The extension works with or without the app.

A note on provider terms: using a consumer chat subscription through automation may break that provider's terms of service. Some allow it, some forbid it, and terms change. Local Studio doesn't decide this for you. Read your provider's terms before you connect a subscription; API keys under a developer agreement are the safer route where terms are unclear.

Chats through the Local Studio app need macOS or Linux for now.

Source: https://github.com/baney75/tychicus
Built on 0xSero's agent bridge and Mario Zechner's Sitegeist.
```

**Homepage:** https://github.com/baney75/tychicus

**Support:** https://github.com/baney75/tychicus/issues

**Images:**

- Icon: `static/icon-128.png`
- Screenshots, 1280x800, in this order: `store/screenshots/welcome.png`, `store/screenshots/agents.png`,
  `store/screenshots/local-studio.png`, `store/screenshots/models.png`, `store/screenshots/site-access.png`.
- Small promo tile, 440x280: `store/promo-small.png`
- Marquee, 1400x560: `store/promo-marquee.png`

## Privacy tab

**Single purpose:**

```
Local Studio lets AI agents operate web pages in the user's browser on the user's behalf, from its side panel or from an AI agent the user connects.
```

**Permission justifications:** paste each row of [permissions.md](permissions.md) into its box.

**Are you using remote code?** Yes.

```
The extension loads no script, module or WebAssembly from outside its package. The agent's page actions run through the Debugger API and the optional User Scripts API, the two APIs the program policies permit for this, and only as those APIs document. Separately, code the agent writes for a task, for example to read a spreadsheet the user attached or draw a chart, runs in sandbox.html, a sandboxed page isolated from extension APIs. Its content security policy allows scripts only from the package itself, and the libraries that code can import (SheetJS, Papa Parse, Chart.js, Three.js, pdf-lib, docx and Tailwind CSS) ship in the package under sandbox-lib/, credited in THIRD_PARTY_NOTICES. Nothing fetched remotely runs with extension API access.
```

**Data usage: what the extension handles.** Tick these:

- Authentication information: API keys the user adds under "Use an API key instead", stored locally and sent only to that provider; and the ChatGPT and GitHub Copilot sign-ins, whose tokens the helper keeps on this computer (the extension never holds them). Sign-ins in the Local Studio app stay in the app.
- Web history: the addresses of pages the agent opens.
- User activity: the agent's clicks and typing in its own tabs.
- Website content: text, images and form contents of pages the agent reads.

Leave the other boxes empty.

**Certify all three:** not sold to third parties, not used or transferred for purposes unrelated to the single purpose,
not used to determine creditworthiness or for lending.

**Privacy policy:** https://github.com/baney75/tychicus/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** Public. **Regions:** All.

## Test instructions for the reviewer

```
No account is needed.

1. Click the toolbar icon to open the side panel.
2. In the welcome, choose "Chat here" and add a key for any listed provider. A free key from openrouter.ai works with Free mode. (Chatting through the Local Studio app, the default when the app runs, needs that app on the same computer. Without it the panel offers API keys, so the reviewer doesn't need it.)
3. Ask: "Open example.com and tell me what the page says."
4. If it asks about example.com, allow it (small and unknown models ask first). A new tab group opens, and the agent reads the page in it.

Connecting a coding agent needs the free Local Studio helper. The welcome shows the command that installs it (curl -fsSL https://github.com/baney75/tychicus/releases/latest/download/install.sh | sh on macOS and Linux). It isn't required to review the side panel.
```
