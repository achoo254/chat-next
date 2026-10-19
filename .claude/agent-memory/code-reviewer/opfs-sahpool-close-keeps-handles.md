---
name: opfs-sahpool-close-keeps-handles
description: In chat-next web, closing a SQLite db on opfs-sahpool does not release OPFS access handles; another worker can only open the pool after pauseVfs() or worker death
metadata:
  type: project
---

Closing the db (`db.close()`, and so `ChatCore.close()`) on the opfs-sahpool VFS (@sqlite.org/sqlite-wasm 3.53.4) leaves the worker holding every SyncAccessHandle in the pool. Another worker's `installOpfsSAHPoolVfs` then fails with NoModificationAllowedError until the first worker calls `pool.pauseVfs()` (which needs all dbs closed) or ends. Re-installing in the same worker returns the cached pool object, so a paused pool must be reopened with `unpauseVfs()`. A failed install is not cached, so retrying works.

**Why:** Checked on 2026-10-15 with Playwright and two module workers while reviewing the leader-handover commit 6f67257. Any handover where the worker stays alive (stepping down instead of closing the tab) breaks the next leader unless the pool is paused.

**How to apply:** When reviewing tab-hub or leader changes that keep the worker alive, check that the pool is paused after the core closes and unpaused on the next startLeader. Fake-core unit tests in tab-hub.test.ts cannot catch this.
