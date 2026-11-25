# Why the extension asks for each permission

Paste each reason into the Chrome Web Store dashboard's Privacy tab, in the box for that permission. The rows match
`static/manifest.chrome.json` one for one: `scripts/build-store.sh` refuses to build the store zip, and
`test/store-package.test.mjs` and `test/store-zip.test.mjs` fail, when the manifest asks for something with no row here
or a row names something the manifest no longer asks for.

| Permission | Why it's needed |
| --- | --- |
| `storage` | Saves settings, the sites the user allowed and the agent's tab state in the browser. |
| `unlimitedStorage` | Chats, skills and the on-device speech model for dictation are kept in the browser and can pass the default quota. Nothing goes to a server of ours; there is none. |
| `activeTab` | Takes a screenshot of the tab the agent works in (`chrome.tabs.captureVisibleTab`), which needs this permission. Screenshots are how the agent checks its work on canvas apps and other pages with no readable text. |
| `scripting` | Reads a page and records what happens on it, so the agent can see the result of each step. On sites with a feed filter the user asked for (Settings > Sites), the extension's own content script reads the posts, on the computer, and hides the matching ones. |
| `sidePanel` | The chat lives in the side panel. |
| `webNavigation` | Keeps track of the agent's tabs when the browser replaces one, and notices when a page navigates, so the agent's tools act on the right page. |
| `debugger` | The agent's clicks, typing and page reads go through the Chrome DevTools Protocol. This is the only way to send real input to a background tab, and to read pages whose security policy blocks injected scripts. It attaches only to tabs the agent opened or the user gave it. |
| `declarativeNetRequest` | One fixed rule set in the package, `ads-rules.json`, blocks requests to known ad networks, off until the user turns on "Block ads" in Settings or asks an agent to, which is listed in Settings > Sites. Rules made from the user's own site edits (Settings > Sites) block the requests those edits name, on the sites the user chose. No other traffic is changed. |
| `tabGroups` | Puts the agent's tabs in their own named group, so they stay separate from the user's tabs. |
| `contextMenus` | Adds "Give this tab to Local Studio" to a page's right-click menu and the toolbar icon's menu, so the user can hand the tab to the side panel or to an agent working in the browser. |
| `nativeMessaging` | Talks to Local Studio's helper on the user's own computer. The side panel's default, "Local Studio", sends each chat through it to the Local Studio app's model service on the same computer, so the extension never holds an API key or sign-in. Coding agents such as Claude Code reach the browser through it too. Key-based providers work without it. |
| `alarms` | Keeps the connection to the helper alive across service worker restarts, and checks the helper's update status. |
| `offscreen` | Reads the text of a PDF the agent opens, page by page, in a hidden page of the extension: Chrome's PDF viewer has no page text, and the reader (pdf.js) needs a worker a service worker can't start. The same page encodes a video of the agent's own tab when the user's agent asks for a recording (a service worker has no video encoder); the helper saves it to a file on the user's computer. Nothing leaves the computer. |
| `userScripts` (optional) | Asked for only when the user turns it on. Runs the agent's page scripts in an isolated world, so they can't touch the page's own scripts and aren't blocked by its security policy. |
| `http://*/*` | The agent works on whatever site the user sends it to, so it can't name them ahead of time. The user picks when it asks, in Settings > Agents: Manual asks before an agent opens a new site; Auto, the default, asks before an agent goes straight to mail, a bank or another sensitive site, and before every new site for a small or unknown model; Yolo, off until the user turns it on, doesn't ask. Where a clicked link or a redirect leads isn't checked. Asks are answered in the side panel, in the agent, or ahead of time with `tychicus allow`, a command on the user's own computer. |
| `https://*/*` | Same as above. |
| `http://localhost/*` | Local development servers, and AI models running on the user's own computer. |
| `http://127.0.0.1/*` | Same as above. |
