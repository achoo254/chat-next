// The control channel's Observatory commands (control-socket.ts), what
// `tunelo observatory status|export|delete|content|rotate-token` asks the
// running agent. Counts, states and row numbers only: never content or a
// token. Each change of what is kept goes to the consent log.
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ObservatoryService } from "../observatory/observatory-service.ts";
import type { ObservatoryStatus } from "../observatory/observatory-status.ts";
import type { AuditLog } from "../safety/audit-log.ts";

const exportInput = z.object({ file: z.string().min(1).max(4096).refine(isAbsolute, "the export file must be an absolute path"), overwrite: z.boolean().optional() });
const contentInput = z.object({ projectKey: z.string().min(1).max(512), storeContent: z.boolean() });
const rotateInput = z.object({ replaceUnreadable: z.boolean().optional() });

/** What these commands use of the machine (machine.ts). */
export type ObservatoryMachine = { readonly observatory: ObservatoryService; readonly audit: AuditLog };
type ObservatoryRoute = (target: { machine?: ObservatoryMachine | undefined }, input: unknown) => unknown;

function machineOf(target: { machine?: ObservatoryMachine | undefined }): ObservatoryMachine {
  if (!target.machine) throw new Error("this tunelo runs tunnels only");
  return target.machine;
}

export const OBSERVATORY_CONTROL_ROUTES: Readonly<Record<string, ObservatoryRoute>> = {
  "GET /observatory/status": (t): ObservatoryStatus => machineOf(t).observatory.status(),
  "POST /observatory/export": async (t, input) => {
    const { file, overwrite } = exportInput.parse(input);
    return machineOf(t).observatory.exportToFile(file, overwrite === true);
  },
  "POST /observatory/delete": async (t) => {
    const m = machineOf(t);
    await m.observatory.wipe();
    m.audit.write({ device: "local", action: "observatory_delete", path: "", detail: "" });
    return { deleted: true };
  },
  "POST /observatory/content": async (t, input) => {
    const m = machineOf(t);
    const { projectKey, storeContent } = contentInput.parse(input);
    await m.observatory.setProjectContent(projectKey, storeContent);
    m.audit.write({ device: "local", action: "observatory_content", path: projectKey, detail: storeContent ? "on" : "off" });
    return { projectKey, storeContent };
  },
  "POST /observatory/rotate-token": async (t, input) => {
    const { replaceUnreadable } = rotateInput.parse(input);
    await machineOf(t).observatory.rotateToken({ replaceUnreadable: replaceUnreadable === true });
    return { rotated: true };
  },
};
