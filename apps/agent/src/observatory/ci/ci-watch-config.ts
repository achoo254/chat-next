// The CI watcher's switch in the agent's config (`observatory.ci.enabled`,
// unset is on). The Observatory master switch still comes first.
import type { ConfigStore, ObservatoryCiConfig } from "../../config.ts";

/** Whether the CI watcher runs (the Observatory switch aside); anything but `false` is on. */
export function ciWatchEnabled(config: ObservatoryCiConfig | undefined): boolean {
  return config?.enabled !== false;
}

/** Switches the CI watcher on or off; watches already running stop at their next poll. */
export function setCiWatchEnabled(config: ConfigStore, enabled: boolean): void {
  config.update((c) => {
    const observatory = (c.observatory ??= {});
    (observatory.ci ??= {}).enabled = enabled;
  });
}
