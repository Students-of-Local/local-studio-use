# Local Studio browser use

@AGENTS.md

AGENTS.md (imported above) is the source of truth for this repository. If anything here
seems to disagree with it, AGENTS.md wins.

Never break these:

- Run the checks before you commit: `./check.sh`, plus `(cd cli && npx tsc --noEmit && npm test)`
  for CLI changes. Fix every error first.
- Stage files by explicit path. Never `git add -A` or `git add .`.
- Never `git commit --no-verify`.
- Skills live in the repository root's `skills/` and come with the Local Studio app. Never keep a
  list, lint or copy of them here.
- Never weaken a check or CI without the maintainer's review.
- Sign-in policy: API keys, plus the sign-ins a provider documents for other apps, under this
  app's own registration. Never add a sign-in that borrows another app's identity
  (docs/auth-policy.md).
- Commit only when the user asks.
