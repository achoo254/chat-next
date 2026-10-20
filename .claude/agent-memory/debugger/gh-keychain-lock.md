---
name: gh-keychain-lock
description: git push / gh hang or fail "could not read Username" on this Mac when the login keychain is locked; GitHub itself reachable
metadata:
  type: reference
---

On this Mac, git's HTTPS credential helper is `gh auth git-credential`, and gh keeps its token in the macOS login keychain (`security find-generic-password -s gh:github.com`). When the keychain is locked (e.g. after the screen locks), every `gh` call and `git push` hangs, or push fails with `could not read Username for 'https://github.com': Device not configured`. `curl https://api.github.com/zen` still returns 200.

**How to apply:** if push or gh hangs, check with a time-boxed `security show-keychain-info` before suspecting the network or the repo. Don't work around it (no tokens in URLs, no `gh auth setup-git`). Stop and ask the user to unlock the keychain, keeping commits local. Seen 2026-10-20 in scribe-next.
