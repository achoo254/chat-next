// A hook process of its own, for the spool tests: appends `count` lines of
// about `size` bytes, tagged `tag`, to the spool under `dataDir`, all in the
// minute of `now`, as fast as it can.
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";

const [dataDir = "", count = "0", tag = "", now = "0", size = "2000"] = process.argv.slice(2);
const pad = "p".repeat(Number(size));
for (let i = 0; i < Number(count); i++) {
  const line = JSON.stringify({ v: 1, src: "hook", event: "Stop", at: Number(now), f: { session_id: `${tag}-${i}` }, c: { last_assistant_message: pad } });
  const outcome = await appendSpoolLine(dataDir, line, Number(now));
  if (outcome !== "written") throw new Error(`line ${i} ${outcome}`);
}
