// `tunelo usage delete`: deletes the usage ledger (token counts read from the
// AIs' transcripts, see docs/privacy/data-inventory.md): its index, monthly
// files and their copies. A
// running agent deletes it itself, so a scan under way does not write it
// back; otherwise the files go here. The next scan starts again from the
// transcripts still on the machine.
import type { Command } from "commander";
import { callControl, controlAnswers } from "../control-socket.ts";
import { configDir } from "../config.ts";
import { deleteLedgerFiles, usageDir } from "../usage/ledger.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

export async function deleteUsage(dir: string, print: (line: string) => void): Promise<number> {
  if (await controlAnswers(dir)) await callControl(dir, "POST", "/usage/delete");
  else await deleteLedgerFiles(usageDir(dir));
  print("Deleted the usage ledger. The next scan reads again the transcripts still on this machine.");
  return 0;
}

export function registerUsageCommand(program: Command, exits: Exits): void {
  const usage = program.command("usage").description("the token usage tunelo keeps from your AI's transcripts on this machine");
  usage
    .command("delete")
    .description("delete the usage ledger (every month) and its copies")
    .action(exits(() => deleteUsage(configDir(), (line) => console.log(line))));
}
