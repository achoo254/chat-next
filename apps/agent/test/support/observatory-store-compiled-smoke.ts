// Built by CI into a Bun executable (`bun build --compile`, as the release
// builds tunelo) and run: the Observatory store from inside a compiled file,
// through bun:sqlite. Opens a database in a new temp folder, writes a
// session, reads it back, wipes it. Prints one JSON line; exits 1 when
// anything differs from what it wrote.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";

const dir = mkdtempSync(join(tmpdir(), "tunelo-observatory-smoke-"));
const path = join(dir, "observatory", "observatory.db");
let ok = false;
try {
  const store = await ObservatoryStore.open({ path });
  store.write([
    { kind: "session", row: { sessionId: "smoke", source: "cli", startedAt: 1 } },
    { kind: "prompt", row: { promptId: "p", sessionId: "smoke", at: 2, length: 5 } },
  ]);
  const timeline = store.sessionTimeline("smoke");
  const result = { runtime: store.runtime, schemaVersion: store.schemaVersion, sessions: store.sessions().length, prompts: timeline.prompts.length };
  await store.wipe();
  const left = readdirSync(join(dir, "observatory"));
  console.log(JSON.stringify({ ...result, filesLeft: left.length }));
  ok = result.runtime === "bun" && result.schemaVersion === 1 && result.sessions === 1 && result.prompts === 1 && left.length === 0;
} catch (err) {
  console.error(err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
