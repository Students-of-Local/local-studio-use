# The hands protocol

The wire between Tychicus (`cli/src/computer.ts`) and a computer-use helper: the program that reads and acts on native
windows for an agent. One protocol, one helper per OS. Any helper that passes the conformance suite
(`cli/test/hands-conformance.test.mjs`) can stand in for any other.

This page writes down the wire exactly as Polycarp's helper spoke it at its last commit with computer use (baney75/polycarp
`e43ee1d6`, tag `pre-hands-removal`: `spaces/Sources/BaneySpacesCore/Hands/MCP.swift`, `Tools.swift`, `Envelope.swift`,
`AccessMode.swift`, `RunSteps.swift`, and `HandsRouter.swift` for the connector cap). Nothing here is new except the
helper's own names (`tychicus-hands`, `tychicus-connector`) and the optional `hands/grants`. Where this page and that code disagree, the code was the
truth and this page is wrong: fix the page and the suite together.

## Helpers and how Tychicus finds one

| Helper | Command | Answers `initialize` as | Connector name |
| --- | --- | --- | --- |
| Tychicus, macOS | `tychicus-hands mcp [--connector]` | `tychicus-hands` | `tychicus-connector` |
| Tychicus, Linux (`hands/linux`) | `tychicus-hands mcp [--connector]` | `tychicus-hands` | `tychicus-connector` |

`computerHelper()` in `cli/src/computer.ts` looks in this order and takes the first that exists:

1. `TYCHICUS_HANDS_BIN` (tests and dev builds; a named path that doesn't exist means none).
2. `tychicus-hands` on `PATH`.
3. `~/.local/bin/tychicus-hands`.
4. Inside a Tychicus app bundle: `/Applications/Tychicus.app/Contents/Resources/bin/tychicus-hands`, then the same under
   `~/Applications`.

Polycarp's `polycarp-spaces` is never used: Polycarp removed computer use (baney75/polycarp #568).

`computer_status` and `tychicus doctor` name the helper that was found and whether it answered, or say there is none
and how to get it on this OS (`handsHowTo`).

A connector's helper runs with a small environment of its own (`connectorHelperEnv`): `HOME`, `PATH`, the way to the
person's desktop (`DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`,
`XDG_RUNTIME_DIR`, `XDG_CURRENT_DESKTOP`, `DBUS_SESSION_BUS_ADDRESS`, `AT_SPI_BUS_ADDRESS`) and where the person's
Tychicus settings live (`XDG_CONFIG_HOME`, `TYCHICUS_CONFIG_DIR` and its inherited names). Nothing else of the
service's reaches it.

### The Linux helper

`hands/linux` is a static Rust binary (x86_64 and aarch64, musl). It reads and acts through AT-SPI, takes windows from
Hyprland, Sway or an X11 EWMH window manager, and on GNOME or KDE under Wayland works through AT-SPI alone and says so.
It never sends physical input. The person's access mode and app list are `hands.json` in Tychicus's config folder
(`{"access": "read_only" | "default" | "full", "apps": [...]}`), read on every call. What Linux can't do in the
background answers `not_supported`: `drag`, right clicks, `press` of a key with no accessibility meaning, `shot` of a
window that isn't on screen on a wlroots compositor, and window management on GNOME and KDE. Under Default a `shot`
that could show another window (one stacked over it on X11, anything on a wlroots compositor) answers `not_supported`
too. An app an agent starts gets a D-Bus session bus of its own, so the person's later launches never reach it. `lend` and `return`
answer `needs_lend` as everywhere. Details, desktops and tests: `hands/linux/README.md`.

### The Mac helper

`hands/mac` is the Mac helper, one arm64 file with the engine linked in. A release
carries it in the darwin archive as `bin/tychicus-hands`, and `tychicus install --release` copies it to
`~/.local/bin/tychicus-hands` (step 3 above). It is signed ad hoc with the hardened runtime and not notarized: no
Developer ID yet. macOS matches a program signed ad hoc by its hash, so a person who allowed the helper itself in
Accessibility allows it again after each update; a grant to the app it runs under (Terminal, say) is unaffected.
Without the grant it answers `hands/grants` (below) and every window verb with the program macOS checks and where to
allow it. Access is Default, or Read Only (`defaults write tychicus-hands agentAccessMode read_only`); there are no
consent sheets yet, so nothing widens it. Details: `hands/mac/README.md`.

## Transport

- stdio, JSON-RPC 2.0, one message per line (UTF-8, `\n`), both ways. Nothing but replies on stdout; logs go to stderr.
- The helper exits 0 when its stdin ends.
- A blank line is ignored. A line that isn't a JSON object gets `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}`.
- A message without `method` (a response) and a message without `id` (a notification) get no reply.
- An unknown method gets error `-32601` with a message that starts `method not found`.

## Methods

### `initialize`

Request params: `{protocolVersion, capabilities, clientInfo}`. Tychicus sends `protocolVersion: "2025-06-18"` and
`clientInfo.name: "tychicus"`.

Result:

```json
{
  "protocolVersion": "<the one asked for, or 2025-06-18>",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": { "name": "tychicus-hands", "version": "<helper version>" },
  "instructions": "<how an agent uses the tools>"
}
```

`serverInfo.name` is the helper's local name, or, when it was started with `--connector`, its connector name. Tychicus
uses a connector helper only when the name is `tychicus-connector`: a helper older than the flag
ignores it and answers with its usual name, and its calls would not be capped. A helper started without `--connector`
never answers with a connector name.

### `ping`

Result `{}`.

### `hands/grants` (optional)

Result `{"missing": [Missing, ...]}`: the OS grants the helper lacks right now, asked of the OS on each call. Empty when
it has them. Each entry:

```json
{
  "grant": "accessibility",
  "message": "macOS hasn't allowed Terminal to use Accessibility, so tychicus-hands can't read or act on windows",
  "suggestion": "Ask the person to open System Settings > Privacy & Security > Accessibility and turn on Terminal (/System/Applications/Utilities/Terminal.app). ...",
  "program": { "name": "Terminal", "path": "/System/Applications/Utilities/Terminal.app" }
}
```

`computer_status` asks it once the tools are listed and, when something is missing, answers with each `message` and
`suggestion` (optional) instead of "available", so the agent can tell the person exactly what to allow. `program` is the program
the OS checks the grant against (on a Mac, the process responsible for the helper), and is optional. A helper without
the method answers `-32601` (an older helper, the Linux one), and Tychicus reads that, and only that, as nothing missing: a
helper that stopped or doesn't answer within 2 seconds is reported as such. The Mac helper implements it.

### `tools/list`

Result `{"tools": [Tool, ...]}`, the same list with or without `--connector`. Each tool:

```json
{
  "name": "click_at",
  "description": "...",
  "inputSchema": { "type": "object", "properties": { "window": { "type": "integer", "description": "..." } }, "required": ["window", "x", "y"], "additionalProperties": false },
  "annotations": { "readOnlyHint": false, "openWorldHint": false }
}
```

- `name` is the verb with `_` for `-` (`set_value`, `click_at`, `run_steps`). Tychicus adds the `computer_` prefix.
- Property `type` is one of `string`, `integer`, `boolean`, or `array` with `items.type` `string` (a list of strings)
  or `object` (a list of objects). Tychicus maps an unknown type to "anything" and lets the helper check it.
- `required` is left out when nothing is required.
- `readOnlyHint` is `true` for the verbs that change nothing and `false` for the rest. `shot` is `false` (it writes a file).
- The list never contains `lend`, `return` or `status`. `lend` and `return` are the person's; `status` is
  `computer_status`, which Tychicus answers itself.

### `tools/call`

Request params: `{name, arguments}`, `name` without the `computer_` prefix. Result:

```json
{ "content": [ { "type": "text", "text": "<envelope or rows>" }, ... ], "isError": false }
```

- `content[0].text` is the envelope as one line of JSON (below), except a successful `snapshot` in rows format, whose
  first part is the rows themselves (one line per element) and never JSON.
- `isError` is `!envelope.ok`.
- A `shot`, or a `snapshot` with `screenshot: true`, adds two parts after the first: a text label that says the image is
  untrusted window content and how its pixels map to window points, then `{"type":"image","data":"<base64 PNG>","mimeType":"image/png"}`.
- A `run_steps` whose closing read is rows adds that read as a second text part, and its envelope says `read.text_below: true`.
- A protocol error (a call without `name`) is a JSON-RPC error `-32602`. Every other failure, an unknown tool and bad
  arguments included, is a result with `isError: true` and an error envelope, never a JSON-RPC error.

## The envelope

```json
{"ok": true, "data": { ... }}
{"ok": false, "error": {"code": "...", "message": "...", "retry": "safe", "suggestion": "...", "next_call": null}}
```

Keys are sorted. Every error carries all five fields. `next_call` is `null` (only the person, or a different request, can
move things on) or `{"tool": "<verb, no computer_ prefix>", "arguments": {...}}`, always a read.

`retry`: `safe` (nothing was delivered; send again as is, or after fixing what the error names), `after_snapshot` (take a
new snapshot and use its refs), `never` (it may have landed, or it will be refused again).

`code`, with its default `retry`:

| Code | Retry | Meaning |
| --- | --- | --- |
| `outside_agent_workspace` | never | The window isn't on the agent workspace and its app isn't lent. |
| `agent_workspace_off` | never | There is no agent workspace. |
| `app_not_found` | safe | No such app running. |
| `window_not_found` | safe | No such window. |
| `ambiguous_window` | after_snapshot | An app-wide request matched several windows. |
| `ambiguous` | safe | An app name matched several processes. |
| `needs_lend` | never | The person must lend the app; an agent can't. |
| `needs_sandbox` | never | The app holds the person's own data. |
| `in_use` | safe | The person is using the app and the wait ran out. Reads never get it. |
| `unknown_ref` | after_snapshot | The ref was never printed to this session. |
| `stale_ref` | after_snapshot | The ref no longer points at its element. |
| `ambiguous_target` | after_snapshot | The ref matches several elements now. |
| `stale_bare_row` | after_snapshot | A bare row number that could mean an older read. |
| `not_supported` | never | The element can't do that. |
| `action_failed` | never | The read-back contradicts the request. |
| `unverified` | never | Input was posted and nothing read back shows it landed. |
| `timeout` | safe | The app didn't answer in time (`never` when an action may have landed). |
| `permission_denied` | safe | The helper lacks an OS grant, or the access mode or connector cap refuses the verb (then `never`). |
| `bad_arguments` | safe | Arguments missing or wrong; `suggestion` starts `usage:` or gives an example. |
| `not_running` | safe | The helper's app part isn't running. |
| `engine_error` | never | Anything else. |

Argument checks, before anything runs, all answer `bad_arguments`:

- an unknown tool (message `unknown tool <name>`), an unknown argument (`unknown argument <k>`), a wrong type
  (`<k> takes a number`, `true or false`, `a list of strings`, `a list of objects`), a required argument missing
  (`<k> is missing`).
- `type`: exactly one of `text` and `paste: true`. `click`: `ref`, or `window` and `text` together, never both.
  `snapshot`, `find`: `app` or `window`. `snapshot`: `format` is `rows` or `json`, `since` is `latest`, `max_elements` is
  1 or more. `wait` is 0 to 120.
- `run_steps`: 1 to 32 steps, each `{tool, args}` (`tool` may carry `computer_`, `-` or `_`). A step's tool must be one of
  `click type set_value press click_at drag scroll select toggle menu`; anything else (a read, `open`, `run_steps`, a
  managing verb, `lend`) is refused as `step N: <tool> can't be a step`, and nothing runs.
- A string argument may be given as a number or boolean; it is read as its JSON text.

## The verbs

Every helper lists these 17. `wait` (integer, 0 to 120 seconds) is an optional argument of every acting verb but `shot`:
how long to wait while the person is using the app.

| Verb | Read only | Required | Optional |
| --- | --- | --- | --- |
| `windows` | yes | | |
| `snapshot` | yes | | `app` string, `window` integer, `query` string, `since` string, `max_elements` integer, `format` string, `interactive` boolean, `compact` boolean, `depth` integer, `screenshot` boolean, `zoom` string |
| `find` | yes | | `app`, `window` integer, `role`, `name`, `text`, `value`, `limit` integer |
| `get` | yes | `ref` | `property` (value, text, title, role, bounds, states), `copy` boolean |
| `shot` | no | `window` integer | `out` string, `zoom` string, `cursor` boolean |
| `click` | no | | `ref`, `window` integer, `text`, `role`, `button` (left, right), `item`, `wait` |
| `type` | no | `ref` | `text`, `paste` boolean, `wait` |
| `set_value` | no | `ref`, `value` | `wait` |
| `press` | no | `ref`, `key` | `wait` |
| `click_at` | no | `window`, `x`, `y` integers | `count` integer, `button`, `item`, `wait` |
| `drag` | no | `window`, `x`, `y`, `x2`, `y2` integers | `steps` integer, `wait` |
| `scroll` | no | `ref`, `direction` (up, down, left, right) | `amount` integer, `wait` |
| `select` | no | `ref`, `option` | `wait` |
| `toggle` | no | `ref` | `wait` |
| `menu` | no | `window` integer, `path` (`File > New`) | `wait` |
| `run_steps` | no | `steps` (list of objects) | `wait` |
| `open` | no | `app` | `targets` (list of strings), `new_window` boolean, `wait` |

Arguments not marked are strings. A ref is `@<snapshot>:e<N>` or a bare row number from the session's latest snapshot.

What each answers in `data` (fields a helper may add to; Tychicus passes them through unread):

- `windows`: `{agent_workspace: int|null, access: "read_only"|"default"|"full", windows: [{id, app, bundle?, pid, title, kind, scope, workspace?, in_use?, ...}]}`.
  `access` is the access the caller works under, after the connector cap.
- `snapshot`: in rows, the rows as `content[0].text` (`[N] role "name" =value (states)`, indented under its parent, with a
  header naming the window and snapshot id). In json, `{snapshot_id, window, tree, ...}`. With `screenshot: true`,
  `screenshot: {path, width, height, points: {width, height}}` and the image parts.
- `find`: `{snapshot_id, window, count, matches: [{ref, role, name, ...}]}`.
- `get`: `{ref, property, value, ...}`.
- `shot`: `{path, width, height, points: {width, height}, cursor, window}` and the image parts.
- acting verbs: `{action, ref?, verified: bool, evidence: {kind, ...}, target: {window, app, ...}, ...}`; `type` and
  `set_value` evidence is `{kind: "value_readback", value, matches, changed}`. `opened: [...]` lists a dialog or sheet
  the action raised. A `click` by text adds `matched: {ref, role, label}`.
- `run_steps`: `{steps: [{step, tool, ok, verified?, landed?, opened?, value?, error?}], done, of, complete, stopped?, note?, read?, read_error?}`.
  Every step is checked before any runs; the run stops at the first step that fails, isn't verified or raises a dialog.
- `open`: `{window, app, pid, focus: {changed, returned}, ...}`.

## Helper extensions

A helper may list more verbs. Polycarp's listed `workspaces`, `query`, `events`, `arrange`, `move`, `switch`, `focus`,
`frame` and `close`. Tychicus's local server offers every listed verb but `lend`, `return` and `status`, with the helper's
own description and schema; a connector session sees only the 17 above, and only those its scopes allow
(`COMPUTER_READ_TOOLS`, `COMPUTER_ACT_TOOLS`). Extension names must match `^[a-z][a-z0-9_]*$`.

## The person's own verbs: `lend`, `return`, `status`

Never listed and never an agent's. `tools/call` with `lend` or `return` answers, in either mode, an error envelope with
code `needs_lend`, retry `never`: lending is a sheet the person clicks in the helper's own app (Polycarp: the Lend sheet,
`LendConsent.swift`), never something an agent's call or a command line can do. `status` is not a helper tool:
`computer_status` is answered by Tychicus, and a helper asked for `status` answers `bad_arguments` (unknown tool).

## The connector cap

`--connector` means the caller is on another machine (a `tychicus serve` session granted `computer.read` or
`computer.act`). It never widens anything. Under it the helper:

1. answers `initialize` with its connector name (`tychicus-connector`; Polycarp's was `polycarp-connector`).
2. works under the person's access mode capped at Default: Full Access becomes Default, Read Only stays Read Only.
   `windows` reports that capped `access`, never `full`.
3. refuses the managing verbs (`arrange`, `move`, `close`, `switch`, `focus`, `frame`) with `permission_denied`, retry
   `never`, message `<verb> isn't open to an assistant connected from another machine`, whether or not it lists them.
4. refuses `lend` and `return` with `needs_lend`, as in local mode.
5. refuses every connector call when the part that enforces the cap can't say it does (Polycarp's CLI asked the app on
   every call and answered `not_running` when the app didn't reply `connector_cap: default`).

Tychicus adds its own layer: a connector session can name only the verbs its scopes allow, and its `run_steps` may only
name step tools it could call itself (`stepRefusal`). That layer is Tychicus's; the helper's cap holds without it.

Under Read Only (local or connector), every acting verb answers `permission_denied`, retry `never`; `shot` still works.

## Conformance

`cli/test/hands-conformance.test.mjs` speaks this protocol to a helper and checks: the transport rules, `initialize` in
both modes, the 17 verbs with their required arguments, types and `readOnlyHint`, the absence of `lend`, `return` and
`status`, the error envelope, argument checks, `run_steps` step checks, and the connector cap (name, capped `access`,
managing verbs and lending refused).

- In CI it runs against `cli/test/helpers/fake-hands.mjs`, a helper that implements the wire with no desktop behind it.
  The same file also runs the suite against broken copies of the fake (a verb missing, a widened connector) and fails
  unless the suite catches each one.
- Against a real helper: `TYCHICUS_HANDS_CONFORMANCE_BIN=/path/to/tychicus-hands node --test test/hands-conformance.test.mjs`
  from `cli/`. To see the cap hold over Full Access, set the person's mode to Full Access first; the suite checks that a
  connector never reports it.
- The Linux helper runs it in CI against its own static binary in a headless desktop (Xvfb with openbox, and headless
  sway), at Full, Default and Read Only, beside `cli/test/hands-linux-live.test.mjs`, which drives every verb on a GTK
  fixture (`.github/workflows/browser-hands-linux.yml`).
- The Mac helper runs it in CI against the signed release build (`hands/mac/scripts/package.sh`) on a macOS runner, at
  Default and Read Only (`.github/workflows/browser-hands-mac.yml`). The runner gives it no Accessibility grant, so window verbs
  answer `permission_denied`: that run proves the wire and the cap, not acting on windows.
