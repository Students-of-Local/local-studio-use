# Skill security

A skill is text an agent follows with the user's sign-in. A bad skill is a prompt
injection that never expires: it runs in every session that loads it. This document is
the threat model for the app's skills (`skills/`) and what stands in the way.

## Defenses

No text filter makes prompt injection impossible. Language models follow instructions
wherever they appear, and an attacker can always phrase an instruction a pattern has
never seen. So a skill is made hard to slip in and cheap to review:

1. **The app's skills ship only through review.** They change only through a pull request, and a
   change to one gets the maintainer's review like a security change.
2. **A skill is text.** A folder holds `SKILL.md`, the short lists it is found by (`asks.txt`,
   `where.txt`, `names.txt`) and a license. Scripts, binaries and symbolic links are refused in review.
   The store follows no link in the app's folder and reads no file over 256 KB.
3. **Someone else's skill can't pass as yours.** The store says where each skill comes from (yours, the
   project's, a plugin's, Local Studio's), and a remote or scoped session is given only the app's.
4. **A skill you save is shown first.** `local-studio skills create` prints it and marks lines that may
   be private; nothing is written until you save it.
5. **Agents never see secrets.** The `proton-pass` skill routes credentials through the
   password manager's own injection (`pass-cli run`, `op run`, `bws run`). A model that
   holds only `pass://` references has nothing to leak.
6. **Page text is data.** The MCP server's instructions and every skill say so, and the
   `rsi` loop refuses lessons copied from page text, so an attack on one page can't
   become a skill edit.
7. **Actions under the user's sign-in need the user's yes,** and site access is
   allowlisted per host (README, Safety model).

## What a reviewer looks for

Hidden text (invisible and bidi characters, lookalike letters, HTML comments), instruction
overrides and fake turns, concealment from the user, downloads run as code, instructions
fetched at run time, secrets or credential files read, printed or posted, agent or shell
settings written, safety switches turned off, encoded blobs, remote images and links that
hide where they go. A prohibition ("never print the password") is fine; check that an
exception in the same sentence doesn't turn it around. Skills describe attacks; they never
quote them, not even in a code fence, because a model reads the raw file.

## Limits

- `scripts/tests/skills-text-test.sh` refuses hidden characters, lookalike letters, HTML comments, links and other files
  in the app's skills. Nothing checks what the words say: review is the gate (D71).
- A required review blocks a merge only if branch protection asks for it.
- An agent with a shell runs as the user and can write any file the user can, skills
  included. The harness's own permission prompts are what stop a hijacked agent.
- A skill of the user's own, or a plugin's, is as trusted as the folder it is in.

## Sources studied

The bundled skills were written for Local Studio, not forked. One is adapted:
`visual-explainer` rewrites the rules of nicobailon/visual-explainer (MIT) into one
`SKILL.md`, with the MIT notice in its folder. Its kit scripts, renderer, CDN libraries,
reader-reply loop and the reference that fetched older recipes from GitHub at run time
were left out (D17). These were read for coverage and rejected as fork bases for the
reasons given:

| Source | Why it wasn't forked |
| --- | --- |
| smixs/osint-skill (MIT) | Uses paid scrapers to get around captchas and login walls; profiles private people |
| Imbad0202/academic-research-skills | CC BY-NC 4.0, not compatible with AGPL-3.0 |
| bitwarden/agent-access examples | Returns the password to the agent; install fetches the skill at run time |
| NousResearch hermes-agent 1password skill | Stores a service token in a dotfile; examples print secrets |
| uditgoenka/autoresearch (MIT) | Sends optional outbound webhooks; ML-specific loop |
| snyk/agent-scan (Apache-2.0) | Sends skill content to a remote API |

Note for anyone adding a Bitwarden route: `@bitwarden/cli` 2026.4.0 on npm carried a
credential stealer (StepSecurity, 2026-04-23). Pin a known-good version.
