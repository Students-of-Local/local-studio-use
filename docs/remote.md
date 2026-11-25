# Use Local Studio from claude.ai, ChatGPT and grok.com

Web assistants can drive your own signed-in browser through Local Studio and, if you tick it when you
approve one, apps on your Mac's agent workspace ([Computer use](#computer-use)). It runs on your computer and
through your own free Cloudflare account (or Tailscale): no account with us, no hosted service, no cost.

**In the Local Studio side panel, use Settings > Connections > "Use Local Studio from Claude, ChatGPT and Grok".** It
walks you through the same steps with buttons. The rest of this page is the terminal.

## Quick start

One command:

```bash
local-studio-browser remote setup
```

It puts a small relay on your own free Cloudflare account, so the connector gets an address with no domain and
nothing on this computer listens to the internet ([The relay](#the-relay)). What you will see, in order:

1. Cloudflare's sign-in page in your browser, the first time. Sign in, or make a free account there. If the account
   has no workers.dev subdomain yet, setup opens the page to pick one and waits for Enter.
2. `Relay deployed at https://local-studio-browser-relay.<your-subdomain>.workers.dev`, then a line while it checks that a request
   through the relay reaches this computer and comes back. A new subdomain can take a few minutes.
3. `From the internet, as an assistant sees it:` and one line per check (public DNS, the certificate, the OAuth
   metadata, the sign-in challenge, a streaming probe). All ok means an assistant can connect now. A brand-new name
   can take a few minutes to reach public DNS; then run `local-studio-browser remote test` again in a few minutes.
4. The connector URL, `https://local-studio-browser-relay.<your-subdomain>.workers.dev/mcp`.
5. A connect code (`TK-XXXX-XXXX`). It works once, for 10 minutes. `local-studio-browser token approval-code` makes another.
6. The passcode, only in the run that made it. Keep it: it re-approves an assistant you already approved.

Then add the connector URL in each assistant you use:

- **claude.ai**: Settings > Connectors > Add custom connector. Paste the URL, then Add.
- **ChatGPT**: Settings > Apps & Connectors, turn on developer mode, then Create. Paste the URL and choose OAuth.
- **grok.com**: grok.com/connectors > New Connector > Custom. Paste the URL.

Each opens Local Studio's approval page. Check the name, tick the permissions, type the connect code and press Allow.

To prove it works from outside at any time, and to repair it:

```bash
local-studio-browser remote test   # what an assistant sees: DNS, TLS, OAuth, sign-in, streaming
local-studio-browser remote fix    # repairs what test or status found, asking before each step
```

## Mac, Linux and Windows

**Mac.** For the Tailscale routes, install Tailscale from the App Store or tailscale.com and sign in; setup finds the app's own `tailscale` at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` when it isn't on PATH. Services run under launchd
(`~/Library/LaunchAgents/com.localstudio.browser.serve.plist`), and the Mac must stay on and awake.

**Linux.** One-time steps (the first only for the Tailscale routes) that Local Studio prints and never runs for you, because both need root or a session change:

```bash
sudo tailscale set --operator=$USER   # lets your user open Funnel
loginctl enable-linger $USER          # keeps your user services running after you log out
```

Services run as systemd user units (`~/.config/systemd/user/local-studio-browser-serve.service`). `remote status` and `remote fix`
warn when either step is missing.

**Windows.** Every route works without administrator rights. Each service is a Task Scheduler task for your account,
and its log is a file in the config folder ([Windows](#windows)). Task Scheduler words a task's status in the system's
language, so `remote status` and `remote fix` treat an installed tunnel task as running; `remote test` says whether it answers.

## Troubleshooting

Run `local-studio-browser remote fix` first: it repairs what it can, one step at a time, and names the rest. `remote test`
and `remote status --json` give the `state` or check name in the first column.

| State or check | What it means | Do this |
| --- | --- | --- |
| `not_set_up` | Nothing is set up on this computer. | `remote setup` |
| `tailscale_missing` | Tailscale isn't installed. | Install it from tailscale.com, then `remote setup --tailscale`. |
| `tailscale_signed_out` | Tailscale isn't connected. | Open Tailscale and sign in (`tailscale up` on Linux). |
| `tailnet_lock` | Funnel doesn't work with Tailnet Lock on. | Use Cloudflare: `remote setup --cloudflare <name>`. |
| `funnel_not_allowed` | Your tailnet hasn't allowed Funnel for this computer. | Open the `adminUrl` page and allow it; setup waits. |
| `funnel_closed` | Funnel was turned off for this address. | `remote fix` opens it again. |
| `cloudflared_missing` | cloudflared is gone. | `remote fix` offers the pinned download. |
| `port_busy` | Another program uses the local port or 8443. | Stop it, or `remote setup --port N`. |
| `dns` | Public DNS has no public address (A or AAAA) for the name, or the lookup failed (SERVFAIL). | No address yet: wait a few minutes for a new name; else `remote fix`. A failed lookup: fix the name's DNS records or DNSSEC with your DNS provider. |
| `dns_lookup` | On `remote status`: the lookup failed (SERVFAIL, REFUSED), which waiting doesn't fix. | Fix the name's DNS records or DNSSEC with your DNS provider. |
| `tls` | The certificate isn't valid for the name, the port speaks plain HTTP, or nothing answers. | `remote fix`; on your own front door, a certificate for the name. |
| `resource_metadata` | The public name reaches something that isn't this connector, or (`pending`) its tunnel or gateway answers 502, 503, 504, 521, 522, 523 or 530 or nothing: it hasn't connected yet. | A pending one: wait a minute, then `remote test`. Otherwise, or if it stays: `remote fix` (restarts `serve` and the tunnel; a renamed computer gets its new URL). |
| `auth_metadata` | The OAuth server metadata names another address, or no authorization or token endpoint on this one. | `remote fix`. |
| `auth_challenge` | `/mcp` doesn't answer a sign-in challenge. | `remote fix`. |
| `streaming` | The stream's first bytes take over 5 seconds, so assistants time out. | Use the relay, Tailscale Funnel or a Cloudflare named tunnel, not a quick tunnel or a buffering proxy. |
| `probe_cleanup` | `remote test` couldn't delete its probe token. It stops working by itself two minutes after it was made. | The `token revoke <id>` command in `next`. |
| `passcode` | No passcode is set. | `local-studio-browser token passcode` (shown once). |
| `linger`, `tailscale user` | Linux one-time steps. | The command in [Mac, Linux and Windows](#mac-linux-and-windows). |

`remote fix` restarts the `serve` and `cloudflared` services, opens Funnel, downloads cloudflared after you say yes, and
rewrites `remote.json` when the computer was renamed. When the name changed it prints the old URL and the new one: add
the new URL in each assistant; the old one no longer works. It never deletes or overwrites a DNS record, runs sudo,
touches Tailnet Lock, turns a route off, revokes a token or connector, or makes a passcode. In a terminal it asks
before each step; `--yes` skips the questions, `--dry-run` lists the steps and changes nothing, and with no terminal and
no `--yes` it changes nothing and exits 3 with the list.

## Check it

```bash
local-studio-browser remote status   # fast checks from this computer
local-studio-browser remote test     # the proof, from outside
```

`remote status` checks `remote.json`, the passcode, whether `serve` answers on this computer, public DNS and a public
fetch. From inside your own tailnet a ts.net name answers even when Funnel isn't reaching the internet, so status adds a
`public test` line pointing to `remote test` when its fetch could have stayed inside the tailnet.

`remote test` asks public DNS (DNS over HTTPS) for the name and connects to that public address with the name as TLS SNI
and Host, as an assistant does. It checks the certificate, `/.well-known/oauth-protected-resource/mcp`, the
authorization server metadata (its issuer, and an authorization and token endpoint, plus any registration endpoint, on
the connector's own address), that `POST /mcp` without a token answers 401 with a `WWW-Authenticate` naming the
metadata, and a streaming probe: an authenticated request whose event stream must start within 5 seconds. The probe
uses a token made for it alone, with the narrowest scope (`skills.read`, no browser access) and a two-minute expiry that
every token check enforces, and deleted when the probe ends, also on Ctrl-C. If the delete fails, the run fails with a
`probe_cleanup` check naming the token's id; the token still stops working at its expiry. Its secret is never printed,
logged or in `--json`. Every request has an absolute deadline, so a proxy that trickles bytes can't stretch it. `remote setup` runs the same checks at its end. The
computer must stay on, awake and signed in to the browser with Local Studio loaded.

## Setup in detail

`remote setup` turns on the route, sets an approval passcode (shown once), writes `remote.json` and installs user
services that keep `local-studio-browser serve` and the route's own connector running. With no route flag it sets up the relay, or
repeats the route that is already on.

In a terminal it waits instead of stopping. On the relay it opens Cloudflare's sign-in, asks which account when there
are several, and waits while you pick a workers.dev subdomain. With `--tailscale`, if Tailscale isn't installed it
prints the download link and waits; if it's signed
out it waits for the sign-in; if Funnel isn't allowed yet it opens Tailscale's page, says what to click and tries again
every 5 seconds for up to 10 minutes; if the service has no launcher yet it writes one (only the launcher; run
`local-studio-browser install` yourself to register browsers). `--no-wait` makes it stop and say what to do instead, and
`--no-input` never asks a question (it needs a route flag). `--json`, or a
run with no terminal, never waits or asks. A connect code is made for a person at a terminal, or with `--connect-code`.

## The relay

The default route. Setup runs Cloudflare's own `wrangler` (version 4.163.0, through `npx`, never installed globally;
npx comes with Node.js 22 or later) in your terminal:

1. `wrangler whoami`, and `wrangler login` when you aren't signed in: Cloudflare's page in your browser. Local Studio never
   reads wrangler's sign-in and never sees a Cloudflare token.
2. With several accounts on the sign-in it asks which one (`--account <id>` without a terminal).
3. `wrangler deploy` of the relay Worker, a copy of `relay/dist` from baney75/local-studio-tunnels kept in
   `cli/src/relay-dist.ts`, as `local-studio-browser-relay` (`--relay <name>` picks another name). It goes to `~/.local-studio/browser/relay/`
   first.
4. A new relay key, 32 random bytes, set as the Worker's `RELAY_KEY` secret through stdin and saved in `remote.json`
   (0600). Every setup run makes a new one, so an old copy of `remote.json` stops working.
5. Two services: `serve`, and the connector (`local-studio-browser remote relay run`, `com.localstudio.browser.relay` or
   `local-studio-browser-relay.service`). The connector dials out to the relay with the key and carries only serve's MCP and OAuth
   paths and `/v1/health` to `127.0.0.1:<port>`.
6. The check: the relay reports the connector, and `GET /v1/health` through it comes back from serve.

`remote status` shows the connector's state: connected, disconnected (it retries), or one it stops on: the key was
refused (`unauthorized`), another computer took over with this key (`replaced`), or the relay speaks another protocol
version (`outdated`). Each of those says to run `local-studio-browser remote setup` again. `remote fix` restarts a connector that
isn't running. `remote off` removes the connector's service and `remote.json`; the Worker stays on your account and
a computer that still has its key can connect until `npx wrangler@4.163.0 delete local-studio-browser-relay` deletes it.

## Tailscale or Cloudflare with your own domain

Both are free and run on your own account. Name one with `--tailscale` or `--cloudflare <name>`; plain `remote setup`
with one of them already on keeps it. Local Studio never makes an account. It installs neither tool, and downloads cloudflared only when you say yes.

- **Tailscale** needs no domain, so it's the quickest. The address is `https://<computer>.<tailnet>.ts.net:8443`.
- **Cloudflare** puts the address on a domain you have on your Cloudflare account, because a Cloudflare tunnel with a
  fixed name needs one. No domain there means Tailscale, or a domain added in Cloudflare first.

From the terminal:

```bash
local-studio-browser remote cloudflare login                        # your browser opens Cloudflare; pick the domain
local-studio-browser remote setup --cloudflare local-studio.example.com
```

`setup` makes a tunnel named `local-studio-browser-<this computer>-<4 hex>` (kept in `~/.local-studio/browser/cloudflare-tunnel-name`), or reuses it, adds the DNS record and keeps both `serve` and
`cloudflared` running as services. It never overwrites or deletes a DNS record: a name already in use is refused, in
Cloudflare's own words. Before it makes anything it asks public DNS which zone the name is in, and refuses a zone public
DNS shows is served somewhere other than Cloudflare, or a name outside the zone an earlier sign-in proved. Local Studio never
reads cloudflared's sign-in file, so with several zones on your account and no earlier setup it can't tell which one the
sign-in covers. If Cloudflare then puts the record in another zone, setup stops, names the record it made, and says you
can delete it in the Cloudflare dashboard (DNS, Records); Local Studio never deletes DNS records. It remembers the zone, so
the next name outside it is refused with nothing made.

In a terminal, `remote setup --cloudflare` does the rest inline: with no `cloudflared` it offers the download below
(y/N; `--yes` accepts, and it never downloads without one of those), signs you in to Cloudflare and waits, asks for the
name if you gave none, and after the tunnel starts checks the public address for up to 5 minutes, with a line while it waits.
`remote off` stops the tunnel and leaves the tunnel and its record on your account, so turning it on again reuses them;
`cloudflared tunnel delete` with the name in `~/.local-studio/browser/cloudflare-tunnel-name` removes the tunnel for good.
Delete only that name; another tunnel on your account belongs to something else.

Settings > Connections does the same with buttons; see "From the side panel" below. If no `cloudflared` is installed it
downloads its own (pinned release 2026.10.7, SHA-256 checked before anything is unpacked or run) to
`~/.local-studio/browser/bin/cloudflared`; one on your PATH or in Homebrew's folders is used first. When Funnel is on,
choosing Cloudflare turns Funnel off only after the tunnel is ready; in a terminal that is
`remote setup --cloudflare <name> --replace-funnel`.

## Tailnet only

`local-studio-browser remote setup --tailnet` serves the connector to your own tailnet devices and nobody else: `tailscale serve` on
https port 443, never Funnel. The address is `https://<computer>.<tailnet>.ts.net/mcp`. Each of Local Studio's nine paths
(`/mcp`, `/authorize`, `/token`, `/register`, `/revoke` and the four `/.well-known/oauth-*` documents) is its own mount, so
anything else this computer serves on 443 is left alone. Setup refuses, changing nothing, when Funnel is on for 443, when 443
forwards raw TCP, or when one of the nine paths already goes somewhere else. `remote off` removes exactly those nine
mounts. claude.ai, ChatGPT and grok.com reach the internet, not your tailnet, so this route is for assistants that run on
your own devices. `remote test` checks it from inside the tailnet.

What Tailscale does with a mount (checked on tailscale 1.104.5):

- `--set-path=/mcp http://127.0.0.1:<port>/mcp` matches `/mcp` and anything below it at a `/` boundary (`/mcp/x`), never
  `/mcpx`. It strips the mount path and appends the rest to the target's path, so with the target ending in the same
  path, the request path and query arrive unchanged.
- A path nothing is mounted on answers 404.
- The Host header arrives as the machine's DNS name with no port, which serve accepts. Tailscale adds
  X-Forwarded-Host, X-Forwarded-Proto `https`, X-Forwarded-For (the caller's tailnet address) and its identity headers.
- Removing the last mount leaves `tailscale serve status --json` at `{}`. Removing a mount that isn't there exits 1 with
  "handler does not exist".

Local Studio's own Cloudflare route uses the same nine paths: its cloudflared ingress sends only those paths to serve and
answers 404 for everything else. `remote cloudflare run` renders that ingress again before each start and keeps the
tunnel, credentials-file and log lines as they are.

## One tunnel with the app

On a computer with the Local Studio app, the app owns the one tunnel, on every route (Cloudflare or tailnet), and
browser use joins it. The design is in `docs/tunnel.md` (baney75/local-studio). The app writes the route
record, `$LOCAL_STUDIO_DATA_DIR/tunnel/route.json` (else `~/.local-studio/tunnel/route.json`):

```json
{ "v": 1, "owner": "local-studio", "route": "cloudflare", "hostname": "studio.example.com",
  "aliases": ["old.example.com"], "ports": { "mcp": 8787, "serve": 18094 } }
```

Browser use only reads it and never creates that folder. The route carries eleven exact paths: browser use's nine on
`ports.mcp` and the app's `/v1/health` and `/v1/ws`.

- `local-studio-browser remote join [--json] [--no-service]` reads the record. It stops and removes browser use's own tunnel service,
  Funnel or tailnet mounts, but never deletes the Cloudflare tunnel, its credentials file or its DNS record, and it keeps
  `cloudflared.yml` so the app can adopt the tunnel. It saves `remote.json` with route `custom`, the address
  `https://<hostname>` and the record's `aliases`, moves serve to `ports.mcp`, and proves the address and each alias.
  If any proof fails, it puts `remote.json`, serve and its own route back as they were and exits non-zero.
- `local-studio-browser remote setup` with a route record joins it. A route flag for another route than the record's refuses with
  code `route_mismatch`: run `local-studio tunnel off` first, or run setup without the flag to join. Without a record, `--cloudflare <name>` or `--tailnet` runs
  `local-studio tunnel setup` with that route and `--json` when `local-studio` is on PATH, then joins. The app's
  folder alone proves nothing (`install --local-studio` makes one). Funnel, no route, `--public-url`, and a re-run on
  this install's own Funnel, Cloudflare or relay route stay browser use's own setup; `remote join` moves that route.
- The app's Cloudflare route runs on your own Cloudflare account; `local-studio tunnel byo` gives the steps
  ([its guide](https://github.com/baney75/local-studio/blob/main/docs/tunnel.md#your-own-cloudflare-tunnel-step-by-step)).
  A `local-studio` that answers no JSON (a build from before tunnel setup) leaves browser use its own route. One that answers
  JSON and fails is a refusal with code `local_studio`.
- Setup through the app makes the passcode and connect code the way its own setup does: a passcode unless
  `--no-passcode`, a connect code for `--connect-code` or a person at a terminal, and code `connect_code` when one asked
  for can't be made. `remote test` and `remote fix` check a joined tailnet route from inside the tailnet.
- An alias is an older address the same route still answers, such as the name a Cloudflare route used before
  the app adopted it. Serve answers OAuth on each alias as its own address: discovery, issuer, resource and the
  WWW-Authenticate challenge use the host the request came in on, and a token works only on the host that issued it.
- `remote status --json` adds `localStudio` (`{route, hostname, aliases, mcpPort, joined}`, or null) and, for
  browser use's own Cloudflare route, `cloudflare` (`{tunnelId, credentialsFile, configFile}`, paths only, never the
  credentials). `remote off` on a joined computer leaves the app's route running and says so.

Without the app, nothing changes: browser use keeps its own route with the same exact paths.

## From the side panel

Settings > Connections > "Use Local Studio from Claude, ChatGPT and Grok" turns it on, on Mac, Linux and
Windows: Tailscale and Cloudflare without a terminal, the relay with one command in it. It asks Local Studio's helper through the native host, so the helper must be installed; nothing the page holds
reaches a command line (the remote methods take no parameters, and the Cloudflare address is checked before use).

1. **Choose a way.** Your own relay (recommended: no domain), Tailscale, or Cloudflare (a domain on your account). "Set up
   my relay" shows `local-studio-browser remote setup` with a copy button, because Cloudflare's sign-in runs in a terminal; the page
   checks every 5 seconds and moves on once setup saves the route. A helper from before the relay gets the words to update
   it instead. From then on the page shows the connector's live state, and for a state the connector can't leave by itself
   (unauthorized, replaced, outdated, stopped) the command that `remote status` names. When it connects
   again, the checks from the internet run again.
2. **Get it and sign in.** The page names what is missing, with one button: Tailscale's download page, the command to
   sign in, or "Turn on" for Cloudflare, which downloads cloudflared and opens Cloudflare's sign-in. It checks every
   3 seconds and moves on by itself. The first screen, once it has shown which ways are ready, checks every 15 seconds.
3. **Turn on.** If Tailscale hasn't allowed Funnel yet, the page opens Tailscale's page once and tries Funnel again every
   5 seconds for up to 10 minutes; no "try again" press is needed. After 10 minutes it stops and shows "Check again".
   On Linux, when Tailscale refuses because your user isn't its operator, the page shows the command to run once and
   retries the same way; after the retry stops, or before anything was saved, it shows "Check again". A Cloudflare name
   that is taken or not on your signed-in domain shows its own step, such as "Pick another name".

The result shows the connector URL, a one-time connect code with a 10-minute countdown and "New code", the steps for
claude.ai, ChatGPT and grok.com (the same lines `remote setup` prints), and the checks from the internet
(`remote test`). A code comes only from a press: Turn on makes one, and when the Funnel retry turned the route on by
itself the result asks you to press New code. A brand-new name that public DNS doesn't have yet, or a tunnel still
connecting, is a `pending` check: the result says the address is still being published and checks again every 30
seconds until it passes. After 15 minutes of that, or when setup's answer names `remote fix`, the check counts as failed.
When a check fails for real and the helper's `remote fix` has something to do, a Repair button runs it; an older helper
shows no button. When Repair stops on something only you can do, the page shows that step with its command, and each
piece of `remote fix`'s advice with its own; do the step, then press Repair again. If Tailscale doesn't answer within 15
seconds, the page says so and changes nothing, rather than asking you to sign in. The side panel never makes or shows a passcode: a new connect code approves an assistant again. The code lives
only in the page's memory and is gone when Settings closes.

The Mac app's Settings > Browser has the same three steps in the same words (they come from one table, held equal by
`test/remote-copy.test.mjs`). Its differences: it has no relay card yet, "Get it for me" asks for the Cloudflare address first and runs
`remote setup --cloudflare <name> --yes`, Funnel is tried again every 15 seconds by running setup again, and a run that
makes the passcode shows it once, labeled for re-approving. The passcode and the connect code are forgotten when
Settings closes, not on a tab switch. Leaving the section pauses the Funnel retry and coming back resumes it, without
opening Tailscale's page again. A setup answer whose `next` is `remote fix` is a failed check with Repair, not a name still
being published, and brings no connect code.

The Linux desktop app has no remote screen; on Linux, use the side panel or the terminal. On Windows the helper finds
`tailscale.exe` and `cloudflared.exe` in their installers' folders as well as on PATH ("Windows" below).

`local-studio-browser tunnel cloudflare` is a quick tunnel for local testing with a token, with no account: a temporary
`*.trycloudflare.com` address that changes each time it starts. claude.ai, ChatGPT and grok.com can't use it, because a
quick tunnel doesn't carry their event stream. For them, use `local-studio-browser remote setup`. It finds `cloudflared` the
same way setup does, including the copy setup downloaded.

## Computer use

Two permissions on the approval page, both unticked until you tick them: `computer.read` (see the
agent workspace and apps you lend) and `computer.act` (see them too, click and type in them, and start
apps from your short list). The assistant gets `computer_*` tools, which run through
`local-studio-computer mcp --connector`. They need that helper, so a machine without it doesn't
offer them. An agent on the Mac itself gets them from the local stdio server without a connector or a
token (README, "Computer use on this Mac"), with the access the helper's own setting names; everything
below is about remote callers only.

A connector is held to Default whatever else is on. Full Access in Settings is for agents on your Mac:
with it on, a connector still sees only the agent workspace and apps you lend, and starts only apps on
the short list. It can't lend itself anything and can't drive an Open or Save panel in any window. An
app Local Studio starts for it can't show a document from outside the handoff folder. Read Only stops it
acting too. An app you lend is lent with what it shows, to every agent and connector with these
permissions, until you take it back or the time runs out. If `local-studio-computer` on
this computer is too old to enforce all this, the connector gets no computer tools.

The agent's apps run as you. Those window rules keep it out of your other windows, but an app can reach
what you can, so tick this only for an assistant you'd let sit at your keyboard. Revoke a connector with
`local-studio-browser token revoke` and everything it was granted ends.

## For an app

`remote status --json` and `remote setup --json` print one JSON object, so an app never reads
sentences. `state` is one of `tailscale_missing`, `tailscale_signed_out`, `funnel_not_allowed` (with
`adminUrl`, the page Tailscale printed), `funnel_closed` (status only), `cloudflared_missing`, `tailnet_lock`, `port_busy`, `ready`, `on` (with
`connectorUrl`), `no_browser_connected` or `problem` (with `message`, and sometimes `code`).
`setup --json` and `join --json` also give `step`, the agent's next move: `ready` (on), `joined` (on through Local
Studio's route), `needs_signin` (Tailscale or Cloudflare sign-in), `needs_dns` (a name or DNS problem) or
`error` (with `code`). With stdin not a terminal they never prompt, so an agent can run setup for someone.
`remote off`, `setup`, `fix` and `join` refuse, with code `service_belongs_to_other_config` and exit 1, when the
installed serve or tunnel service names another config folder than this shell's (a run with LOCAL_STUDIO_BROWSER_DIR set
under the same HOME as the person's own install). They change nothing, and the message names both folders.
`status --json` also has `routes`: `tailscale` and `cloudflare`, each with `installed` and `signedIn`, read without changing anything.
`setup --json` includes `passcode` only in the run that made it, even when that run then fails, so
keep it. `token passcode --json` makes a new one. It mints no connect code unless you pass `--connect-code`; then it adds
`connectCode` (`TK-XXXX-XXXX`) and `connectCodeExpiresAt` (milliseconds since 1970, 10 minutes on). Neither is logged.

`setup --json` also says what comes next in `next`: `{kind, url?, command?}`, where `kind` is `install` (with the
download `url`), `sign_in` (with the `command`), `open_page` (`url`), `run_command` (`command`; a `<name>` in it is yours to fill in, as in `install --browser <name>`), `choose_name` (pick
another Cloudflare name) or, on `on`, `add_connector` (`url`, the connector URL). The exit code is 0 for `on`, 1 for a
failure, 2 for a usage error and 3 when a person has to do something, which `next` names.
`remote off --json` prints `{ok, message, notes}` with the same 0 or 1.

`setup --json` ends with `checks`, the same list `remote test --json` gives (below). Only a failure marked `pending`
(no public address yet, or nothing answering yet) is what a new name looks like for a few minutes; setup is then `on` and
says to run `remote test` later. One pending failure is reported as a `problem`: the name resolves and has a certificate,
but the tunnel in front of `serve` answers 502, 503, 504, 521, 522, 523 or 530, or nothing, as a Cloudflare tunnel does
for a minute after its service starts. `--json` never waits, so it reports this at once with `next` `run_command`
`remote test` (exit 3); only a person at a terminal on Tailscale or Cloudflare waits, asking every 5 seconds for up to 5
minutes, and then gets `next` `remote fix`. On your own front door (`--public-url`) the same answer is a fault (exit 1):
point it at `127.0.0.1:<port>`. Any other failed check (a refused certificate, a 421, another connector's metadata, a
held stream, no sign-in challenge) makes setup a `problem` whose `code` is that check's name, exit 1, with the saved
`connectorUrl`, and `remote.json` is kept. Every failure after `remote.json` is saved carries `connectorUrl`. With `--connect-code`, a code that can't be made is a `problem` with `code`
`connect_code`, the reason in `connectCodeProblem`, the `connectorUrl` and, when this run made it, the `passcode`; it exits
1 and the route stays set up.

`remote test --json` prints `{ok, state, code?, message, publicUrl, connectorUrl, checks}`. `state` is `on` when every
check passes, else `problem` with `code` naming the first failed check. Each of `checks` is `{name, status, detail,
next?, pending?}`: `status` is `ok`, `warn` or `fail`, `next` is the one thing to do after a failure, `pending` is true on
a failure that waiting fixes (no public address yet, a refused connection, no route from this computer, a resolver's
HTTP error, or a gateway status or no answer past TLS), and `name` is, in order, `dns`, `tls`, `resource_metadata`, `auth_metadata`,
`auth_challenge`, `streaming` or `probe_cleanup` (only when the probe's token couldn't be deleted). Checks after a failed `dns` or
`tls` don't run, and `streaming` runs only when `resource_metadata` passed. `remote fix --dry-run` always exits 0, even when
a step only you can take blocks the rest; the JSON still names it. Nothing set up is `code` `not_set_up` with
`next` `run_command`. Exit codes: 0 every check passed, 1 a check failed, 2 usage, 3 nothing is set up. No token is
ever in it.

`remote fix --json` prints `{ok, state, code?, message, next?, publicUrl, oldUrl?, newUrl?, actions, advice, checks?}`.
Each of `actions` is `{kind, what, status, detail?}`; `kind` is one of `download_cloudflared`, `rename`,
`restart_serve`, `restart_cloudflared` and `open_funnel` (they run in that order), and `status` is `planned`, `done`,
`failed` or `declined`. `advice` lists steps only you can take, `{name, detail, command?}` (`passcode`, `linger`,
`tailscale user`). `oldUrl` and `newUrl` are there after a `rename`: the connector moved, so the old URL no longer works.
`checks` is the outside proof, run once nothing is left to repair. `code` `fix_pending` means repairs are listed and
nothing was changed (`--dry-run`, which exits 0, or no terminal and no `--yes`, which exits 3). A step only you can take
uses the same `state` values as status (`tailscale_signed_out`, `funnel_not_allowed` with `next` `open_page`, and so on)
and exits 3. Exit codes: 0 ok, 1 a repair or a check failed, 2 usage, 3 a person has to act or nothing is set up.

`code` says why when it matters. For `problem`: `launcher`, `hub`, `service`, `serve` (nothing answers
on the local port, so nothing was turned on), `funnel` (Tailscale's own words are in `message`),
`tailscale_operator` (Tailscale refused because your user isn't its operator; `next` has the command),
`cloudflare_login`, `cloudflare_name` (no name was given), `cloudflare_zone` (public DNS shows the name's zone served
elsewhere, or it is outside the zone an earlier sign-in proved, both checked before any record is made; or Cloudflare
put the record in another zone, which `message` names so you can delete it), `cloudflare_dns` (`next` `choose_name` only
when the name is taken; any other cloudflared error has no `next`), `cloudflare_tunnel` or
`config`. A failure after the passcode was made, such as a file that can't be written, is a `problem` with
`code` `config`, `service` or `funnel`, and still carries the `passcode`. For `port_busy`: `tailscale_port` (a saved Tailscale setting already uses 8443) or
`local_port` (a program on this computer uses the local port). A status read on the Funnel route
names `tailscale_missing`, `tailscale_signed_out` or `tailnet_lock` ahead of `problem`, and
`funnel_closed` when Tailscale's Funnel isn't open for the saved address (status only; `remote setup`
opens it again). `problem` with `code` `dns` means the only failures are public DNS and the public
fetch, which lag a new address by minutes: waiting fixes it. `code` `dns_lookup` means public DNS answered that the
lookup failed (SERVFAIL or REFUSED, often broken DNSSEC): waiting doesn't fix it; fix the name's records with your DNS
provider. `code` `tailscale_silent` means a Tailscale read took longer than 15 seconds: nothing was changed, and the
answer is never "on" or signed out. The side panel and the Mac app show "Tailscale didn't answer, checking again" and read
again by themselves until Tailscale answers.

`funnel_not_allowed` means Tailscale printed its login.tailscale.com page for enabling Funnel. The
helper returns it as soon as the page appears and stops that `tailscale funnel` call, which would
otherwise wait; every `tailscale funnel` call is bounded at 30 seconds. On the Funnel route, `on` is reported only after
`tailscale serve status` shows Funnel on for the machine. The Mac app's own `tailscale` is found at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` when it isn't on PATH, so the terminal and the
app behave the same.

## What you need

- Local Studio installed and connected (`local-studio-browser setup`, then `local-studio-browser install` so the service has a
  launcher to start).
- For the relay: Node.js 22 or later (it brings npx) and a free Cloudflare account.
- For Tailscale Funnel: Tailscale on this computer, signed in. Free plan is enough. If Funnel isn't allowed for your
  tailnet yet, `local-studio-browser remote setup --tailscale` opens the Tailscale page that allows it and waits while you
  allow it (with `--no-wait`, `--json` or no terminal it prints the page and stops; run setup again after).

On Linux, two more things:

- Tailscale refuses changes from a user who isn't its operator, with "Access denied" and its own advice. Setup
  prints the fix and waits for you to run it once; Local Studio never runs sudo:

  ```bash
  sudo tailscale set --operator=$USER
  ```

- A systemd user service stops when you log out unless lingering is on. Setup and `remote status` warn when it
  isn't, with the fix: `loginctl enable-linger $USER`. `remote status` also warns when Tailscale has no operator.

Funnel runs on its own port (8443), so the OAuth paths sit at the root of the URL, and anything
you serve on 443 stays private.

## If Funnel won't work

`local-studio-browser remote setup --tailscale` stops, without changing anything, when:

- Tailscale isn't installed (in a terminal it waits for you to install it instead).
- The tailnet has Tailnet Lock on. Funnel doesn't work on a Tailnet Lock tailnet.
- Port 8443 on this computer already serves something else, or forwards plain TCP.
- A `remote.json` or a service from an earlier setup is in the way (`local-studio-browser remote off` clears it).

The free way out is your own HTTPS front door. A Cloudflare named tunnel costs nothing (an
account includes 1,000) and needs a domain on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create local-studio-browser
cloudflared tunnel route dns local-studio-browser local-studio-browser.<your domain>
```

Point the tunnel at Local Studio in `~/.cloudflared/config.yml`:

```yaml
tunnel: local-studio-browser
credentials-file: /home/<you>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: local-studio-browser.<your domain>
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it (`cloudflared tunnel run local-studio-browser`, or as a service with `cloudflared service install`),
then tell Local Studio the address:

```bash
local-studio-browser remote setup --public-url https://local-studio-browser.<your domain>
```

`--public-url` takes an origin only (`https://host`, no path). Any HTTPS front door that forwards
to `127.0.0.1:8787` works the same way. `--port N` changes the port; `--no-service` skips the
service, and you start `local-studio-browser serve` yourself. Quick tunnels (`trycloudflare.com`) won't do:
the name changes on every start.

If you switch from Funnel to your own front door, run `local-studio-browser remote off` first so Funnel closes;
setup refuses to switch while Funnel from an earlier setup is on.

## Add the connector

Paste `<public URL>/mcp` in each:

- **claude.ai**: Settings > Connectors > Add custom connector.
- **ChatGPT**: Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.
- **grok.com**: grok.com/connectors > New Connector > Custom.

Each opens Local Studio's approval page. Check the name and the site you return to, tick the
permissions, enter the connect code setup printed and press Allow. A new assistant needs a connect
code; the passcode alone is refused for one (D34). Code used or expired? `local-studio-browser token approval-code`
makes another. Later approvals of an assistant you already approved take the passcode. Only approve a connection
you just started. Lost the passcode? `local-studio-browser token passcode` makes a new one; approvals you already
gave keep working.

## Windows

Both routes work on Windows without administrator rights, and Local Studio runs no installer. Install Tailscale or
cloudflared yourself as usual, or let the Cloudflare route offer Local Studio's own copy of cloudflared (Windows on x64 only;
it asks first, as on the Mac, and checks the download's SHA-256 before using it). Local Studio finds `tailscale.exe` and
`cloudflared.exe` on PATH, then in the installers' folders (`C:\Program Files\Tailscale`, `C:\Program Files\cloudflared`,
`C:\Program Files (x86)\cloudflared`), then its own copy, `bin\cloudflared.exe` in the helper's config folder.

Windows has no user service like launchd or systemd, so each service is a Task Scheduler task for your account alone:
`com.localstudio.browser.serve`, plus `com.localstudio.browser.cloudflared` on the Cloudflare route (`com.localstudio.browser.hub` and `com.localstudio.browser.link`
for a hub and a device). Each starts when you log on, runs with your own limited rights, stores no password, and runs a
small script that starts the program again 10 seconds after it stops. They live in the helper's config folder, the same one
it uses everywhere else: `%USERPROFILE%\.config\local-studio-browser`, or `LOCAL_STUDIO_BROWSER_DIR` when you set it. Tasks named
`com.localstudio.browser.*` are the Local Studio app's; leave them to it.

- The scripts the tasks run: `services\com.localstudio.browser.serve.cmd` and the others beside it.
- The logs: `logs\local-studio-browser-serve.log`, `logs\local-studio-browser-cloudflared.log` and so on (Windows has no journal). When the
  program starts again, a log past 10 MB becomes `<name>.log.1`, replacing the one before; a program that runs for weeks
  keeps writing to the same log until then.

The scripts name no folder: each finds the config folder from its own place, so a profile folder with letters outside
ASCII works.

Each task shows a command window while it runs, titled with its name. Closing that window stops the service until you
log on again or run setup again. `schtasks /Query /TN com.localstudio.browser.serve /V /FO LIST` shows a task.

`local-studio-browser remote off` removes it: it ends the tasks, ends the programs they started with `taskkill /T` and checks
they are gone, then deletes the tasks and their scripts, and keeps the logs. Each program records its pid and start time
when it starts and marks the record `exited` when it exits; a pid is ended only while Windows (`Get-Process`) reports the same
start time, so a pid Windows has since given to another program is never touched. A program that won't stop, one whose
start time can't be read, or a running task with no record leaves its task in place and says what to end in Task Manager.
If Windows refuses to make a task, in any language, setup says your organization may block scheduled tasks and how to run
`local-studio-browser serve` yourself instead.

When setup asks you to allow Funnel, it opens the page in your default browser (on Windows through `rundll32.exe
url.dll,FileProtocolHandler`, so no command line parses the address) and prints the address either way.

## Revoke

```bash
local-studio-browser token clients   # connectors and their grants
local-studio-browser token revoke tkc_...  # remove one client and every grant it holds
local-studio-browser remote off      # close Funnel, stop the service, delete remote.json
```

`remote off` leaves approvals in `oauth.json`. They can't be used while the URL is gone, but they
become usable again if you set up later with the same URL. `local-studio-browser token clients` lists them and
`local-studio-browser token revoke <client id>` ends them for good.

On a custom route (`--public-url`), `remote off` can't close your front door: your own tunnel
keeps forwarding to this computer. Stop it there, for example by stopping `cloudflared`.

### After a relay key or tunnel token leaked

Someone who runs a second connector with your relay key or tunnel token receives some of the requests
meant for you, including approval page submissions, which carry your passcode.

1. Turn the route off: `local-studio-browser remote off`.
2. End the old credential, which `remote reset` doesn't do. Relay: `npx wrangler@4.163.0 delete
   local-studio-browser-relay`, so the old key opens nothing. Cloudflare: delete the tunnel in the dashboard, or
   rotate its token there. Leave the route off until step 4.
3. Set a new passcode and end every grant (bash or zsh; the passcode isn't echoed or kept in history):

   ```bash
   (umask 077; IFS= read -rs p; printf '%s\n' "$p" > ~/new-passcode)   # at least 20 characters
   local-studio-browser remote reset --new-passcode-file ~/new-passcode [--yes] [--json]
   rm ~/new-passcode
   ```

4. Turn the route on again with `local-studio-browser remote setup` and your route's option. The relay gets a new
   key, and so does every setup run after it.

`remote reset` reads the new passcode from that file (never the command line or the environment)
and refuses a file group or others can read or write, a link, an empty file, or a passcode shorter
than 20 characters (the random part of one `token passcode` makes) or longer than 200. Then it
sets the passcode the way `token passcode` does, and ends every OAuth grant (access and refresh
tokens), every client registration, every waiting connect code (approval codes, and a hub's device
codes) and the signing key, so an approval form or authorization code issued before is refused too.
Every assistant connects again with a new connect code: `local-studio-browser token approval-code` makes one.

An agent can run the reset for you. At a terminal it asks before it changes anything. Without a
terminal, and always with `--json`, it never asks: it needs `--yes`, and without it refuses with
code `confirmation_required` and exit 2, changing nothing. The JSON report gives `state` (`done`,
`failed` or `refused`), a `code` when refused (`usage`, `passcode_file`, `config_folder`,
`confirmation_required`, `declined`), what was ended and kept, and `next`, the command to run:
`chmod 600` for a file others can read, the same reset in the service's folder or with `--yes`,
the reset again after a failure, and `token approval-code` once it is done.

It also revokes every static `tkr_` token from `token create`. A static token never passes through
`/authorize`, so the passcode leak doesn't reach it, but any `/mcp` request relayed through the
second connector carried its bearer token, and Local Studio can't tell which tokens were used through
the tunnel. Make new ones with `local-studio-browser token create`.

On a hub (this folder has `hub.json` or `hub-devices.json`) it also removes every enrolled device, for
the same reason: a manager device sends its credential over the same tunnel, and Local Studio can't tell
which credentials crossed it. A running hub refuses them at once and closes their links within a
second. The report lists the removed devices, and `next.relink` gives the `hub code` command for
each; run it here, then `local-studio-browser link <hub url> --code <code>` on that device. Link tokens stay: a serve with a public
route refuses them, so none that works ever went through a tunnel, and a hub link keeps working.

A running serve refuses the old tokens on the next request and closes their open sessions within
a second. The command reads every file back and exits 0 only when the passcode is the new one and
no grant, client, connect code or static token is left; 1 when a step or the read-back failed (the
report names what is left; run it again); 2 when it refused the file or the folder, or wasn't
confirmed, and changed nothing. When a serve or hub service reads another config folder than this shell (its own, or the default
`~/.local-studio/browser` when it was set up with none while this shell sets `LOCAL_STUDIO_BROWSER_DIR`), the
reset is refused with that folder's name: run the command with `LOCAL_STUDIO_BROWSER_DIR` set to it. On Windows the file's permissions
aren't checked, since NTFS access lists aren't in its mode bits.

## Security notes

- Anyone on the internet can reach the URL. Two things stand between them and your browser: the
  connect code or passcode on the approval page (a new assistant needs the one-time code; five wrong tries per
  connection, then a 15-minute wait) and the per-permission consent. Keep the passcode in a password manager the browser Local Studio drives can't fill, and don't reuse it.
- An approval carries only the permissions you ticked; there is no wildcard. `browser.script`
  (run code in a page as you) and `threads.read` (your past chats) start unticked. Leave them off
  unless you need them.
- Access tokens last an hour, refresh tokens rotate, and an old refresh token coming back ends
  the grant. Only hashes are stored, in `oauth.json` (0600), next to `remote.json` (0600).
- Agents work in their own tab group, in your signed-in browser. Opening a site asks as your permission mode says
  (GUIDE.md, Safety model); where a clicked link or a redirect leads isn't checked in any mode. Revoke a connector you
  stop using.
- `serve` listens on loopback only and answers only the public host and loopback names.

## Many devices, one connector

One connector URL for claude.ai, ChatGPT and grok.com, and any number of your own computers behind
it. The hub runs on an always-on box (a small server, a Raspberry Pi) and needs no browser. Each
computer that has a browser with Local Studio dials in. It is still your own server, with no relay and
no cost (D32).

On the always-on box, with an HTTPS front door pointing at `127.0.0.1:8787` (a free Cloudflare
named tunnel works, as in "If Funnel won't work" above):

```bash
local-studio-browser hub setup --public-url https://local-studio-browser.<your domain>  # hub.json, a passcode (shown once), a service
local-studio-browser hub code                                      # a one-time code, valid 10 minutes
```

On each computer with a browser:

```bash
local-studio-browser link https://local-studio-browser.<your domain> --code TK-XXXX-XXXX [--name laptop] [--scope browser.read,browser.act]
```

`link` enrolls the computer and installs a user service (`com.localstudio.browser.link` or
`local-studio-browser-link.service`) that runs `local-studio-browser link run`. `--scope` is what this computer allows at
most; without it, the default grant (no `browser.script`, no `threads.read`). Then add
`https://local-studio-browser.<your domain>/mcp` once in each assistant, as above. Approve with your passcode,
or with a one-time code from `local-studio-browser token approval-code` (or `local-studio-browser link approval-code` on a
manager device): the field reads "Passcode or connect code". A connector you have not approved
before (a new client) needs the one-time code; the passcode alone is refused for it, so a link
someone else sends you cannot be approved by typing the passcode (D34). Once a client is approved,
later approvals for it take the passcode as before.

```bash
local-studio-browser hub devices         # online, extension, sessions, busy, last seen
local-studio-browser hub prefer laptop,desktop  # who wins a tie
local-studio-browser link busy on        # on a device: new sessions go elsewhere first
local-studio-browser hub status          # hub.json, passcode, local answer, public DNS and fetch, devices
```

Settings > Connections in the side panel does the same from the browser: it shows the connector URL,
makes a one-time code for the approval page, lists the devices (on the hub's computer), makes a
connect code for another device, and joins a hub from a code. It asks Local Studio's helper, so it needs
`local-studio-browser setup` first. See D33 in [decisions.md](decisions.md).

### What a device allows

A device's cap lives in its own `link.json`, and only that computer changes it. Nothing the hub
sends can write it.

```bash
local-studio-browser link scopes                         # what this device allows
local-studio-browser link scopes --remove browser.script # narrower: the next call that needs it is refused
local-studio-browser link scopes --add browser.script    # wider: applies once link run starts again
```

A narrower cap applies to the very next call, also on sessions already open: that call gets
"laptop doesn't allow browser.script (allows: ...). Only its owner can add it, on laptop." `link run`
reads `link.json` at every tool call, inside its local server, after the call's arguments are parsed,
so the check judges the call that runs. It counts arguments too: `read_network` with `requestId`
needs `browser.script`, and `session_info` with `label` needs `browser.navigate`. In front of the
local server, a body on an open session that doesn't parse as UTF-8 JSON is refused, and the
content-type the server sees is always `application/json`. The last scope can't be removed;
`local-studio-browser link off` stops serving. A wider cap needs a new link token, so `link scopes --add`
restarts the link service when there is one, and open sessions start over.

Computer use (`computer.read`, `computer.act`) is not available over a link yet. Granting it needs
the owner's approval on that computer, which Local Studio can't ask for yet, and nothing else can stand in for it:
a yes typed at a terminal can come from an agent running the command in a pseudo-terminal, and an
agent with a shell can edit `link.json` by hand. So:

- `link --scope computer.act` and `link scopes --add computer.act` (or `computer.read`) are refused
  and change nothing: "computer.act can't be turned on from the command line: granting computer use
  over a link needs the owner's approval on this computer, and Local Studio can't ask for it yet."
- `link run` never serves a computer scope, whatever `link.json` says. That includes a cap an
  earlier preview build wrote: it loses its computer scopes. `link run` logs one line naming them,
  and `link status` (and `link status --json`, as `notServed`) says which ones and why. It also drops
  any scope this computer can't serve.
- The next `link scopes` change writes the cap without them.
- Joining a hub from the side panel never grants computer use, and the panel doesn't offer it.

A computer without `local-studio-computer` is told "This computer can't serve computer.read: computer use
needs Local Studio's computer-use helper, local-studio-computer, and it isn't on this computer.", then how to get it there.

A cap written as an empty list allows nothing; only a `link.json` with no `scopes` gets the default
grant. Removals are checked under `link.json`'s lock, so two at once can't empty the cap.

### How a session is routed

A new session goes to an online device that has reported in, grants at least one of the caller's
scopes, and has room (fewer than 32 requests in flight, and fewer sessions than its own cap of 24).
Of those, devices whose extension is connected come first. Then, in order: full coverage of the
caller's scopes, not busy, the fewest sessions, your `prefer` order, the one seen most recently. If no
device has its extension connected, any of them takes it (tools such as `skill_search` still work).
If none is online, the assistant gets a 503 that names each device and when it was last seen; if
none grants any of the caller's scopes, a 403 that names what each allows; if all are full, a 429.
Requests carry up to 4 MB of body in frames of up to 16 MB, and a request that would not fit a
frame after escaping gets a 413 without disturbing the link. A response is streamed with backpressure:
a client that stops reading is cancelled after 30 seconds. A session
stays on its device and only for the caller that opened it. When that device goes away, the next
request on its session gets 404, the assistant starts a new session, and another device takes it.

### Pick a device for one call

The hub sends every device a list of all of them (the roster), and a session behind a hub has a
`devices` tool: each device's name, id, platform, online or when last seen, what it allows, and
whether it has the browser extension and computer use. Every other tool takes an optional `device`
(a name or id from `devices`). Without it, a call runs on the session's own device, exactly as
before. With another device's name, the hub sends that one call there, in a second session it opens
on that device for this session (once, then reused, and closed when this session ends), and removes
`device` from the call first.

- The second session gets the caller's own scopes, narrowed by that device's own cap on the device,
  as any new session is. What the session's first device allows never carries over.
- The hub checks the target's cap before it sends anything, and refuses a tool outside it:
  `Parish1 doesn't allow computer.act (allows: browser.read, ...). Only its owner can add it, on Parish1.`
- An offline device: `Chapel1 is offline (last seen 2026-11-10 14:02). Nothing was sent. Online now: Mac, Parish1.`
  A name the hub doesn't know: `No device called "X". Devices: Mac, Parish1, Chapel1.`
- A device that drops while the call runs: `Parish1 went offline while this call ran. The action may
  have landed: read it back before you repeat it.`
- Each of these is a tool result marked as an error, never an HTTP failure, so the session stays.
- A call that still names another device when it reaches one (an older hub, or a JSON-RPC batch, which
  the hub doesn't route) is refused there and nothing runs.
- Site approvals: no session through a hub asks the assistant to approve a site, on its first device
  or another. A new site waits for you in that device's side panel (Settings > Agents), and the
  assistant is told to ask you to allow it there.

### Revoke

```bash
local-studio-browser hub remove laptop  # the credential stops working, the live link closes within a second
local-studio-browser link off    # on a device: stop the service, forget the hub, revoke its link token
local-studio-browser hub off     # stop the hub service and remove hub.json (devices stay enrolled)
```

`hub code --manage` makes the device a manager: it can run `local-studio-browser link code` and
`local-studio-browser link approval-code`, which ask the hub for codes over HTTPS with the device credential.
Use it only for a computer you would trust with the passcode.

### Security notes

- Callers reach a device only through the hub. The hub sets the caller's scopes itself and drops
  any `x-local-studio-hub-*` or `x-local-studio-hub-*` header a public client sends (the hub headers keep their old names). A device narrows them by its own cap; it never
  widens. A device's link token works only on the loopback server `link run` starts.
- A device credential is 32 random bytes, stored on the hub only as a SHA-256 hash; connect codes
  and approval codes are single-use, last 10 minutes and are stored only as hashes. Wrong connect
  codes are limited (five per source, 20 in all, per 15 minutes, so anyone can pause enrollment, and
  only enrollment, for 15 minutes); wrong approval codes count toward the passcode's limit and
  15-minute lockout. A valid device credential is never refused because of other people's failures.
- Only one `local-studio-browser link run` can run on a device; a second refuses to start. When the link drops,
  the device closes the sessions it carried, and assistants simply start new ones.
- The hub listens on loopback and answers only its public host. A device removed with
  `local-studio-browser hub remove` loses its link within a second.
- Cost: free. Nothing here runs on anyone else's server.

See D30, D31 and D32 in [decisions.md](decisions.md) for why each install is its own server.
