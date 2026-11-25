# Skill platform

How an agent finds a skill, and how a user's own edit of a bundled skill is kept. Security
rules for skill text are in [skill-security.md](skill-security.md); the context budget is
decision D12 in [decisions.md](decisions.md).

## How an agent finds a skill

- The browser server has no skills of its own. Its `skill_search` and `skill_read` pass through to one
  `local-studio skills mcp`, started at the first call (`cli/src/skills.ts`). Without Local Studio on the machine they
  answer "Skills come with Local Studio, which isn't installed here. Work without one." In a thread Local Studio started
  (`LOCAL_STUDIO_SKILLS_SERVER`), which already has that server, neither tool is offered.
- The first browser result on a host in a session ends with the names of that host's skills (`cli/src/skill-lines.ts`).
  So does the first `computer_*` result that lands on an app, with the skills for that app.
  The host is the one the extension reports, the app the one the computer-use helper reports. The result waits at most 300 ms for the names, and an incognito window's page is never looked up.
- Remote sessions (`tychicus serve`) see both tools only with the `skills.read` token scope.
  They find the skills that come with the app only, never the user's own: a
  remote session can be a cloud agent off the user's devices, and personal skills stay on
  them (D6). Any session created with a tool scope (`allowedTools`) gets the same, whether
  or not it is marked remote.

## Versions

A skill's version is the first 12 hex digits of the SHA-256 of its SKILL.md, so the same
text has the same version wherever it is stored.

- `tychicus skill list --json` gives each skill's name, description, version and source
  (`bundled` or `local`).

## Size budget

`tychicus skill lint skills` includes the `budget` rule: every SKILL.md is 150 lines and 8,000
characters or fewer. A local edit applied before the budget existed is still used when it's
over; `tychicus skill list` and `install` warn, naming the file and the rule.
