# Local Studio privacy policy: browser extension and helper

This policy covers Local Studio's browser extension, which lets AI agents work in the user's browser, and its helper
program, the `local-studio-browser` command. It was last changed on 2026-11-25. "The app" below is the Local Studio desktop app, a
separate program.

## What is collected

Nothing, for its developer. There is no account, no analytics, no automatic crash reporting and no server of its own. The
developer receives none of the data below, except what the user chooses to post (a bug report) and the download counts GitHub shows for each release.

Every host named below sees the computer's IP address, as any site does.

## What stays on the user's computer

- Chats, settings, skills, the sites the user allowed, and API keys the user chose to add are stored in the browser,
  under the extension's own storage.
- The helper keeps its settings and logs in its own folders (`~/.local-studio/browser`, `~/.local/share/local-studio-browser`,
  `~/.cache/local-studio-browser`).
- **A copy of the chats, on by default.** So that the user's coding agents can look up past chats, the helper keeps a copy
  of side panel chats in `~/.local/share/local-studio-browser/threads`, readable only by the user. Keys pasted into a chat are
  removed from the copy, and chats marked private are never copied. Older versions didn't mark private mode chats, so chats
  from before that mark are copied only with the switch "Also chats from before" that date. The copy is not uploaded. Agents the user connects can
  read it and may send what they read to their own AI; one connected remotely needs a token with the `threads.read`
  scope. Settings > Privacy > "Let my coding agents read my past chats" turns it off and deletes the copy.
- Tokens for the ChatGPT and GitHub Copilot sign-ins (Settings > Providers) are kept by the helper in files only the user
  can read. The browser never holds them.
- Recordings and network captures an agent asks for are saved as files on the user's computer.

## What it contacts by itself

| What | Host | When | How to turn it off |
| --- | --- | --- | --- |
| Update check, with the helper's name and version. Automatic updates also download the release. | `api.github.com`, `github.com`, and `release-assets.githubusercontent.com` for the files | About daily. A source checkout runs `git fetch` instead. | Settings > Updates, or `LOCAL_STUDIO_BROWSER_NO_UPDATE_CHECK=1` |
| Model details, with no key, chat or page | `models.dev` | Only with a key saved for a provider that lists its models, when the copy is a day old | Settings > Privacy > "Look up model details on models.dev" |
| Model lists, with the user's key for that provider (none for OpenRouter and Synthetic) | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.mistral.ai`, `api.groq.com`, `api.x.ai`, `api.cerebras.ai`, `router.huggingface.co`, `api.synthetic.new` | When the panel opens and the list is an hour old, only for providers with a saved key | Remove the key |
| Free model list, with no key | `openrouter.ai` | When the panel opens and the copy is a day old, also with Free mode off | No switch |
| A page's own icon | The address that page gives, which can be another site's | When the panel shows that page | No switch |

## What leaves the computer to answer the user

- **The app (the default).** The side panel sends each chat, and what the agent reads from a page, to Local Studio on the
  same computer through the helper. A local model keeps it on the computer. A subscription the user signed in to inside
  the app sends it to that subscription's provider. The extension never sees a key or a sign-in token.
- **A ChatGPT or GitHub Copilot sign-in.** The side panel sends the chat to the helper on the same computer, which adds the
  user's token and forwards it to OpenAI (`api.openai.com`) or GitHub (`api.githubcopilot.com`, or the Copilot address
  GitHub gives the user's plan). Signing in and renewing use `auth.openai.com`, or `github.com` and `api.github.com`.
  Copilot's kit is GitHub's own program, installed from `registry.npmjs.org`; what else it contacts is GitHub's choice. The sign-in itself runs on that provider's own page.
- **An API key the user added.** The chat and what the agent reads go straight from the browser to that provider.
- **Free mode.** Messages go to free models through OpenRouter (`openrouter.ai`), which may keep and train on them. It asks
  first, tries models that keep nothing first, and removes keys, card numbers and US Social Security numbers from the text.
- **Private mode.** When the user turns it on, prompts go only to models that promise not to keep them, or to machines
  the user named as their own.
- **Coding agents the user connects** (Claude Code, Codex and others) get what they ask the browser for, through the
  helper on the same computer. What they send on is under that agent's own policy.
- **Remote connectors, hubs and linked devices.** Off unless the user runs `local-studio-browser remote setup`, `local-studio-browser hub setup`
  or `local-studio-browser link`. Then an assistant the user added as a connector (claude.ai, ChatGPT, grok.com) or the user's own
  hub machine can ask the browser for page content and tool results. Those travel over the tunnel the user set up, on
  the user's own Tailscale Funnel or Cloudflare account, or to the hub machine the user named. Every request needs a
  sign-in the user approved. Setting it up looks the name up at `cloudflare-dns.com` and can download cloudflared from
  `github.com` and `release-assets.githubusercontent.com`. For the relay, the usual route, setup runs Cloudflare's own program, wrangler
  (downloaded from `registry.npmjs.org`, its usage reports off), to put a small Worker on the user's own Cloudflare account,
  and the tunnel is a connection to that Worker's workers.dev address; what wrangler contacts is Cloudflare's choice.
  `local-studio-browser remote off` closes a connector, `local-studio-browser link off` unlinks this computer from a hub, and `local-studio-browser hub off`
  stops a hub; each leaves the other two alone. A relay Worker stays on the user's Cloudflare account until they delete it.
- **Pages, files and searches.** The agent opens the pages and files the user's request calls for. Reading a PDF uses the
  user's cookies for that site. Search and crawl go only to the user's own SearXNG or Firecrawl.
- **Papers saved to the library** are looked up by DOI at `doi.org`, `api.crossref.org` and `api.openalex.org`.
- **Dictation** downloads its model from `huggingface.co` and its file servers, such as `us.aws.cdn.hf.co`, on first use. Speech stays on the computer.
- **Code the agent writes in the panel** can load libraries from `esm.run`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`,
  `cdnjs.cloudflare.com`, `cdn.skypack.dev` and `cdn.tailwindcss.com`, data from those and `t1.gstatic.com`, and pictures
  from any https site. The Chrome Web Store build can't.
- **Linux guests.** The first `local-studio-browser vm up` on a Mac downloads the Debian image (about 300 MB) from `cloud.debian.org`,
  which sends the download to one of Debian's mirrors. The image is checked against a fixed SHA-512. Nothing is sent
  beyond the request. What runs inside a guest reaches the network as it would on any computer. Without `vm`, none of it.
- **Installing.** The install command downloads from `github.com` and `release-assets.githubusercontent.com`.

Each provider's own privacy policy and terms cover what it does with the data.

## Other agents' settings files

The helper opens these on the user's computer. Nothing read from them is sent off it.

- **`local-studio-browser setup`, `setup --agents` and `doctor`** read all of `~/.claude.json`, `~/.codex/config.toml`,
  `~/.config/opencode/opencode.json`, `~/.cursor/mcp.json` and `~/.omp/agent/mcp.json` (or where the agent's own variable
  puts them), and use only the MCP server entries, whose project paths they may print. `~/.claude.json` also holds Claude
  Code account details. `doctor` writes nothing. `setup` shows each change and writes after a yes or `--yes`, with a full
  copy of the file beside it first (`.local-studio-backup-<time>`, same permissions). Those copies are not removed.
- **The MCP server, when it starts,** reads the model setting from Claude Code's `settings.json` files or Codex's
  `config.toml`, from the starting program's command line and from `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` and
  `OPENAI_BASE_URL`. The model's name goes to the extension.
- **`local-studio-browser claude-allow on` or `off`** adds or removes one rule in `~/.claude/settings.json`, with no backup.
- **`local-studio-browser install --local-studio`** adds its entry to `~/.eukhe/settings.json` after a backup, and puts its files in
  `~/.local-studio/plugins`. `pi-extension` adds a file to pi's folder.

## Bug reports

Off by default. When the user turns on "Keep error reports so I can send them", errors from the side panel are kept in
the browser with web addresses, emails and keys removed. Nothing is sent: the user reviews the report, copies it, and
pastes it into a GitHub issue they open and post themselves. Turning the switch off deletes the kept errors.

## What the agent can see

The agent reads and acts only in tabs it opened or the user gave it, kept in their own tab group. The user picks when it
asks before a site, in Settings > Agents. Manual asks before an agent opens a new site. Auto, the default, asks before an agent goes
straight to mail, a bank or another sensitive site, and before every new site for a small or unknown model; an agent on a
frontier model opens ordinary sites without asking. Yolo, off until the user turns it on, doesn't ask. The question is
about sites an agent opens itself: where a clicked link or a redirect leads isn't checked in any mode.

Site edits, feed filters and site scripts are the exception to the agent's own tabs. When an agent makes one for a site, it
also applies in the user's tabs on that site, then and on every later visit: an edit hides or restyles parts of the page,
blocks requests or turns ad blocking on, and a filter reads the page's posts, on the computer, to hide some. A site script runs
code there, signed in as the user, and only after the user turns it on. Each is listed in Settings > Sites, with a switch
and a Remove button. The helper keeps a copy of the list in `~/.local-studio/browser/sites.json`, readable only by the user,
which a new browser profile starts from with every script off.

The agent hands the tab back for captchas, and for sign-ins it either hands the tab back or opens a small window that
names the site and takes the user's username and password. Those go into that page's fields and nowhere else, and the
agent isn't given them, though a script it runs in the page (`run_js`) could read the fields.

## Data sale and use

User data is not sold, not used or transferred for anything but the single purpose above, and not used to decide
creditworthiness or for lending.

## Contact

Questions and requests: https://github.com/baney75/local-studio/issues
