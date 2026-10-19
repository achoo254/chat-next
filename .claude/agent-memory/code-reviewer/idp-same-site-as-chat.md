---
name: idp-same-site-as-chat
description: auth.hoandat.com (IdP) and chat.hoandat.com share site hoandat.com — SameSite=Strict chat cookies ARE sent on IdP->callback redirects and from any *.hoandat.com page
metadata:
  type: project
---

The IdP (auth.hoandat.com) and chat (chat.hoandat.com) are the same *site* (eTLD+1 hoandat.com). Comments/ADR in chat-next that say "the IdP's redirect to the callback is cross-site" are wrong for production.

**Why:** Found while reviewing session replacement (00a5264, 2026-10-15); design still worked but rationale was false, and sibling subdomains can trigger same-site top-level navigations carrying the Strict session cookie.

**How to apply:** When reviewing cookie/CSRF logic in chat-next, treat other *.hoandat.com hosts as same-site; __Host- prefix is what stops subdomain cookie planting. Related: [[idp-refresh-rotation-reuse-revokes-grant]].
