---
name: idp-reauth-not-forwarded-upstream
description: auth-next prompt=login/max_age=0 does not reach Google/GitHub upstream (Google always prompt=select_account), so RP "re-auth" via auth_time is weak
metadata:
  type: project
---

auth-next `src/accounts/upstream-google.ts` always sends `prompt: "select_account"` and never forwards `max_age`/`prompt=login` from the RP's authorization request. A fresh `auth_time` from auth-next therefore only proves a click on the upstream account chooser, not a password re-entry (seen 2026-10-23 reviewing Miu World's move to auth-next, where PIN lock-out reset relied on it).

**Why:** Relying parties (Miu PIN reset, any "recent login" gate) assume auth_time ≈ real re-authentication, as with direct Google + max_age=0.

**How to apply:** When an RP behind auth-next uses `prompt=login`/`max_age`/`auth_time` as a security gate, check whether auth-next forwards re-auth to the upstream (or exposes `amr`) before accepting it as strong. Related: [[idp-refresh-rotation-reuse-revokes-grant]].
