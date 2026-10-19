---
name: idp-refresh-rotation-reuse-revokes-grant
description: hoandat-auth IdP rotates refresh tokens on every refresh and revokes the whole grant if a consumed token is replayed — losing a rotated token in chat-next logs the user out
metadata:
  type: project
---

hoandat-auth (sibling repo /Users/hoandat/inet-gitlab/hoandat-auth, src/oidc/provider.ts rotateRefreshToken + sliding-grants.ts) rotates the refresh token on every refresh; presenting an already-consumed refresh token revokes the grant.

**Why:** In chat-next, any failure after the IdP token endpoint succeeded (ID-token/JWKS verify error, DB commit failure, ctx deadline, SIGKILL during pm2 reload) that drops the rotated token means the next hourly grant check replays the old token, so the IdP revokes the grant and the chat session is ended.

**How to apply:** When reviewing chat-next refresh/grant-check code (server/internal/auth/sessions.go, idp.go Refresh, store/grant_check.go), treat "rotated token not persisted" as a user-visible logout bug, not a transient error. Also: pm2 daemon runs as root on the shared server and opens log files in /var/log/chat with flags 'a' (follows symlinks), so that dir must not be owned by the app user.
