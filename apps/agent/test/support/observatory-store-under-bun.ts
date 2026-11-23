// Run with Bun (the runtime of the released tunelo), from
// test/observatory/store-under-bun.test.ts: opens the Observatory database
// at argv[2], which the test wrote under Node, through bun:sqlite; reads a
// session back, adds one prompt for the test to read under Node, and
// prints one JSON object of what it saw.
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun observatory-store-under-bun.ts <database path>");
  process.exit(2);
}

const store = await ObservatoryStore.open({ path });
const result = { runtime: store.runtime, schemaVersion: store.schemaVersion, timeline: store.sessionTimeline("s1") };
store.write([{ kind: "prompt", row: { promptId: "from-bun", sessionId: "s1", at: 1, length: 3 } }]);
store.close();
console.log(JSON.stringify(result));
process.exit(0);
