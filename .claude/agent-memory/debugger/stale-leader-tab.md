---
name: stale-leader-tab
description: chat-next web keeps one DB-owning leader tab (Web Lock); a prod fix "not working" after deploy may be an old-bundle tab still leading
metadata:
  type: project
---
In chat-next web, a single tab's worker owns the local SQLite DB (exclusive Web Lock `chat-core-leader:<host>`); other tabs are followers whose core calls run on the leader. On 2026-10-15 a client repair "did nothing" on prod because a pre-deploy tab of user 1 held the lock and served the new tab.

**Why:** reloading one tab does not replace the code that owns the DB; networking from the leader's worker does not show in the follower tab's DevTools.

**How to apply:** when a deployed client fix seems ineffective, first ask for `navigator.locks.query()` and whether other tabs/windows are open, and check whether GetState/GetDifference appear in that tab's network log (absent = follower). Since this incident, a leader of an older build steps down for a newer build's tab.
