# Moving agents from Polycarp

Before Local Studio, the browser tools came from Polycarp's browser helper, so your agents may have an MCP entry, usually named `polycarp`, that runs `polycarp browser mcp`, `polycarp-browser mcp`, `tabkyra mcp` or Polycarp's old browser launcher (`~/.config/polycarp/browser/polycarp mcp`). Once Polycarp drops its browser, those agents lose their browser tools. `tychicus setup --agents` (and the agent step of `tychicus setup`) moves them in two steps in one run: the move, then the rename to `tychicus`.

## See what would change

```bash
tychicus setup --dry-run
```

For each agent config that runs Polycarp's browser server, this prints the file, the entries it would move, and the exact lines before and after, as `diff -u` shows them; for each entry that already runs Local Studio's server under an older server name, such as `polycarp` or `tabkyra`, it prints the rename the same way. It writes nothing. `tychicus doctor` lists the same agents with a warning.

## Step 1: move them

```bash
tychicus setup --agents        # asks first; add --yes to skip the question
```

`tychicus setup` does the same move in its "Connect your coding agents" step. Each entry it finds keeps its name, position and env, and only its command and arguments change: it now runs Local Studio's launcher (`~/.config/tychicus/tychicus mcp`). No second entry is added, so each agent still starts one server. Step 2 then renames it, in the same run.

If the file already has a `tychicus` entry beside the old one, the agent runs two Local Studio servers until step 2 removes the old name, and the plan says so.

How each file is written:

- Before writing a file it saves a copy beside it, named `<file>.tychicus-backup-<time>`, with the same permissions.
- Only the moved entries change. The rest of the file, comments and indent included, stays byte for byte. The result is parsed before it is written, and a result that doesn't parse is refused.
- Just before the write, the file is read again. If an agent changed it while you were reading the plan (Claude Code writes `~/.claude.json` often), the move is made again on the new text and written only if it moves the same entries you said yes to. Otherwise that file is refused with "it changed while you were deciding" and nothing is written to it; run the command again.
- A symlinked config (dotfiles) is written through the link and stays a link.
- Running it again finds nothing to move and writes nothing.

| Agent | File (user scope) |
| --- | --- |
| Claude Code | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set), top-level `mcpServers` |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME` when set), `[mcp_servers.<name>]` and its subtables |
| OpenCode | `~/.config/opencode/opencode.json`, `mcp` (read as JSONC: comments and trailing commas are fine) |
| Cursor | `~/.cursor/mcp.json`, `mcpServers` |
| OMP | `~/.omp/agent/mcp.json`, `mcpServers` (strict JSON: OMP itself skips a file with a trailing comma) |

Codex's file is read with a TOML parser ([smol-toml](https://github.com/squirrelchat/smol-toml)), so a `tychicus` server written as an inline table or with dotted keys is found. The edit itself is made in the table's text, so comments and layout stay.

A config that doesn't parse is left alone, with the reason printed. If its text names `polycarp` or `tabkyra`, setup counts that as a failure, since an entry may be stuck there; fix the file and run it again. If it names neither, there was nothing to move in it, so setup prints a warning and carries on.

What it leaves alone:
- any entry that runs something else, including the Polycarp app's own `polycarp mcp`
- an entry with extra arguments after `mcp` (it names it so you can move it by hand)
- a Codex entry written as an inline table or with dotted keys (named, to move by hand)
- Polycarp's own folders and launchers, which it never reads or writes

Claude Code's project scope (`projects.<folder>.mcpServers` in `~/.claude.json`, the `local` scope) is not edited. An entry there with the same name wins over the user entry in that folder, so the plan and `tychicus doctor` name each one that runs Polycarp's browser server, with the fix:

```bash
cd <folder> && claude mcp remove <name> -s local
```

Restart an agent that was running for it to pick up the change.

## Step 2: rename to tychicus

Right after the move, `tychicus setup --agents` renames each such entry to `tychicus`, the name the server and the command keep for now. It asks first (`--yes` skips the question) and shows the exact lines. These entries are aliases, listed in `~/.config/tychicus/agent-aliases.json`; an entry named `polycarp` or `tabkyra` (any case) that runs Local Studio's launcher counts too, so an entry moved before this step existed, or one whose list couldn't be written, is renamed as well. `tychicus doctor` warns about each with the one fix, `tychicus setup --agents`. To run only the rename:

```bash
tychicus setup --agents --finish --dry-run   # see the renames
tychicus setup --agents --finish             # asks first; add --yes to skip the question
```

Tool names follow the server name, so a rule, hook or prompt that named the old one (a Claude Code permission rule for `mcp__polycarp`, an AGENTS.md line about "the polycarp MCP server") needs the new name; setup says so after a rename. Local Studio never edits those.

Each alias is renamed to `tychicus` in place, with the same command, env and position. When a `tychicus` entry is already there and matches the alias in every field (command, args, env, `enabled` and the rest, in any key order), the alias is removed instead. When they differ in any field, both are left for you to settle by hand, with the fields named, and the command exits 1: removing the alias could drop the server the agent actually runs, such as an enabled alias beside a disabled `tychicus`, or its env. Neighboring aliases are removed in one edit. `--dry-run` writes nothing, the alias list included. Files are backed up and checked the same way as in step 1, each finished alias leaves `agent-aliases.json`, and running it again changes nothing. An agent then reaches the same tools as `tychicus` (tool names such as `mcp__tychicus__navigate` in Claude Code).
