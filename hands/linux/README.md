# local-studio-computer for Linux

Local Studio's computer-use helper for Linux: `local-studio-computer mcp [--connector]`. It speaks the hands protocol
(`docs/hands-protocol.md`) over stdio, reads and acts on windows through AT-SPI, and never sends physical input: no
synthetic keys, no pointer moves, no typing into the window the person is using. What it can't do in the background it
refuses with a protocol code.

One static binary per architecture (musl, about 2 MB, no shared libraries):

```sh
cargo build --release --target x86_64-unknown-linux-musl
cargo build --release --target aarch64-unknown-linux-musl   # links with rustup's rust-lld (.cargo/config.toml)
install -m 755 target/x86_64-unknown-linux-musl/release/local-studio-computer ~/.local/bin/
```

The Local Studio helper finds it on `PATH` or in `~/.local/bin` (`findHelper` in `cli/src/computer.ts`); `LOCAL_STUDIO_COMPUTER_BIN` names
one outright.

## Desktops

| Desktop | Windows from | Agent workspace | `open` | `shot` |
| --- | --- | --- | --- | --- |
| Hyprland | `hyprctl` socket | `special:local-studio-browser` | `exec [workspace special:local-studio-browser silent]` | Full Access: grim, when the window is on screen |
| Sway | sway IPC | `local-studio-agent` (a named workspace) | its own Wayland socket (security-context-v1) with a random instance id; `for_window` and `no_focus` name that id. Before Sway 1.10: `[pid=N]` rules, with the pid held by `local-studio-computer hold` until Sway exits; `flatpak run` and `snap run` are refused, and a window that lands off the agent workspace is closed with its app | Full Access: grim, when the window is on screen |
| X11 (EWMH window manager) | `_NET_CLIENT_LIST` | none: an agent's window is the one an agent started | started, focus watched 1.2 s and given back when the new app took it | X11 GetImage, clipped to the screen; under Default only when no window is stacked over it |
| GNOME, KDE (Wayland) | AT-SPI frames only | none | Full Access only: started where the compositor puts it | not supported |

GNOME and KDE on Wayland give another program no window list, no way to place a window off screen or keep it from
focus, and no window pictures. There the helper reads and acts through AT-SPI only, an app it starts opens wherever the
compositor puts it (often in front of the person, so `open` needs Full Access there), and `shot` and `close` answer
`not_supported`. `windows` says which
case it is in (`desktop: "atspi-only (GNOME)"`).

## Who may use what

The person's access mode and app list live in `hands.json` in the Local Studio helper's config folder (`LOCAL_STUDIO_BROWSER_DIR`, else
`$LOCAL_STUDIO_DATA_DIR/browser`, else `~/.local-studio/browser`), read on every call so a change applies at once:

```json
{ "access": "default", "apps": ["gnome-text-editor", "/home/me/bin/tool"] }
```

- `access`: `read_only`, `default` (the default, and what any other value reads as) or `full`. A connector
  (`--connector`) never gets more than `default`.
- Under `default`, an agent may use windows on the agent workspace and windows of processes an agent started, and may
  start editors, calculators and viewers (`DEFAULT_APPS` in `src/engine.rs`, by command or desktop file, never by a
  path) plus the apps in `apps`. The person's own windows are `outside_agent_workspace`, and so are those of an app
  started under `full`.
- An app started under `default` runs confined (`src/confine.rs`): Landlock lets it, and anything it starts, read the
  system's programs and settings and its own program file, and read and write only a home folder of the agents' own
  (`app-home` in the data folder) and the handoff folder, where nothing runs as a program. Its file dialogs reach nothing
  else of the person's. Landlock does not cover sockets, so the app starts without the variables that name the session's,
  and the default apps are ones that run no plugin, script or command. An app in `apps` that does (an editor with
  plugins, a terminal) could reach the session through them: list one only if the agent may have that. A kernel
  without Landlock, and an app that starts through `flatpak run` or `snap run`, answer `not_supported`: `open` needs
  `full` there.
- Under `full`, every window is open to an agent on this computer, and any app may be started.
- Browsers, mail, chat, file managers, password managers, contacts and calendars are never started for an agent, in
  any mode (`needs_sandbox`): they hold the person's own data and sessions. The helper looks through `env`,
  `flatpak run` and `snap run` and follows symlinks to the program at the end, matches names by family
  (`google-chrome-stable`, `com.google.Chrome` and `microsoft-edge-beta` all count), and reads a desktop entry's
  categories (`WebBrowser`, `Email`, `Chat` and the like). An app started through a shell, an interpreter or an opener
  such as `xdg-open` is refused too: the helper can't tell what it starts.
- An app an agent starts runs on a D-Bus session bus of its own (a private `dbus-daemon`, gone when the app exits),
  with the accessibility bus passed by address. Most editors and viewers run one copy per session bus, so the person's
  own later launch of the same app starts their own copy instead of opening in the agent's.
- A `hands.json` that is there but can't be read or parsed means Read Only until it is fixed, and `windows` says why
  (`settings_problem`). A missing file means Default.
- `lend` and `return` answer `needs_lend`: Linux has no lend sheet yet.

An action on an app the person is using (its window has focus) waits up to `wait` seconds, then answers `in_use`.

## What the background can't do on Linux

- `drag`: Wayland gives no pointer input to a window in the background, and on X11 it would move the person's pointer.
- Right clicks: context menus aren't offered through accessibility.
- `press` of a key with no accessibility meaning (F5, Tab, arrows): Linux has no way to send a key to a background
  window without typing into the person's. Return, Enter, space, ctrl+a, BackSpace, Delete, Home, End and single
  characters work, as accessibility actions or text edits.
- `shot` of a window that isn't on screen on Hyprland or Sway (grim captures outputs), and anything on GNOME or KDE.
  A picture is of the screen, so it shows whatever covers the window: under Default, X11 pictures a window only when
  no window is stacked over it, and Hyprland and Sway picture nothing (notifications and panels aren't windows the
  helper can see). Full Access lifts both.
- GTK 3 menus: activating a menu bar item through accessibility posts its menus for a moment. `menu` waits until they
  close (`menus_closed` in its answer) before it returns.

## Tests

`test/headless-session.sh x11|sway -- <command>` runs a command in a private desktop: its own runtime folder, session
bus, accessibility bus and display (Xvfb with openbox, or sway on the headless wlroots backend), with a stand-in for the
person's window holding focus. Nothing reaches the desktop the person is using. `HANDS_SESSION_LOGS=<dir>` keeps the
display server's, window manager's and registry's logs.

```sh
cargo test
# Every verb on the GTK fixture (test/fixture.py), and end to end through `local-studio-browser mcp` (build cli/ first):
test/headless-session.sh x11 -- env LOCAL_STUDIO_COMPUTER_LIVE_BIN=$PWD/target/x86_64-unknown-linux-musl/release/local-studio-computer \
  node --test ../../cli/test/hands-linux-live.test.mjs
# The protocol suite against the binary, at the mode hands.json in LOCAL_STUDIO_BROWSER_DIR sets:
test/headless-session.sh x11 -- sh -c 'cd ../../cli && LOCAL_STUDIO_COMPUTER_CONFORMANCE_BIN=... node --test test/hands-conformance.test.mjs'
```

The session needs Xvfb, openbox and xdotool (or sway and grim), at-spi2-core, dbus, gdbus, and PyGObject with GTK 3.
CI installs them with apt and runs both desktops (`.github/workflows/browser-hands-linux.yml`).
