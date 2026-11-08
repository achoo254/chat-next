// A second process changing local-forward.json: blocks ports `from`..`to`
// one update at a time, as a `tunelo config local-forward block` would.
import { ForwardSettings } from "../../src/tunnels/forward-settings.ts";

const [dir = "", from = "0", to = "0"] = process.argv.slice(2);
const settings = new ForwardSettings(dir);
for (let p = Number(from); p <= Number(to); p++) {
  await settings.update((s) => {
    s.blockedPorts.push(p);
  });
}
