// The projects whose content is not stored, as the agent's config keeps them
// (config.ts `observatory.contentOff`): the source of truth. The store's
// content_settings rows and the hooks' state.json are copies made from it,
// at start, after every change, and again after a wipe.
import type { ConfigStore } from "../config.ts";
import type { WriteOp } from "./store/write-ops.ts";

/** The project keys whose content is not stored. */
export function contentOffOf(config: ConfigStore): readonly string[] {
  return config.get().observatory?.contentOff ?? [];
}

/** Records in the config whether `projectKey` stores content. */
export function setContentOff(config: ConfigStore, projectKey: string, storeContent: boolean): void {
  config.update((c) => {
    const keys = new Set(c.observatory?.contentOff ?? []);
    if (storeContent) keys.delete(projectKey);
    else keys.add(projectKey);
    c.observatory = { ...c.observatory, contentOff: [...keys].sort() };
  });
}

/** The store writes that copy the config's projects without content into content_settings. */
export function contentOffWrites(keys: readonly string[], now: number): WriteOp[] {
  return keys.map((projectKey) => ({ kind: "contentSetting", row: { projectKey, storeContent: false, updatedAt: now } }));
}
