// `tunelo --help`: the visible commands in two groups, the machine's and the
// tunnels'. Commander 12 has no help groups, so the top-level help is laid
// out here with its Help helpers; every subcommand keeps the stock layout.
import { type Command, Help } from "commander";

export const HELP_GROUPS: readonly { title: string; commands: readonly string[] }[] = [
  { title: "Machine", commands: ["login", "logout", "status", "update", "uninstall", "logs"] },
  { title: "Tunnel", commands: ["http", "tcp", "kill", "watch", "config"] },
];

/** Lays out the top-level help of `program` by HELP_GROUPS. */
export function configureGroupedHelp(program: Command): void {
  program.configureHelp({
    formatHelp: (cmd, helper) => (cmd.parent ? Help.prototype.formatHelp.call(helper, cmd, helper) : groupedHelp(cmd, helper)),
  });
}

function groupedHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth ?? 80;
  const indent = "  ";
  const item = (term: string, description: string): string =>
    description ? helper.wrap(`${term.padEnd(termWidth + 2)}${description}`, helpWidth - indent.length, termWidth + 2) : term;
  const list = (lines: string[]): string => lines.join("\n").replace(/^/gm, indent);

  const out = [`Usage: ${helper.commandUsage(cmd)}`, ""];
  const description = helper.commandDescription(cmd);
  if (description) out.push(helper.wrap(description, helpWidth, 0), "");

  const visible = helper.visibleCommands(cmd).filter((c) => c.name() !== "help");
  const placed = new Set<string>();
  for (const group of HELP_GROUPS) {
    const lines = group.commands.flatMap((name) => {
      const c = visible.find((v) => v.name() === name);
      if (!c) return [];
      placed.add(name);
      return [item(helper.subcommandTerm(c), helper.subcommandDescription(c))];
    });
    if (lines.length > 0) out.push(`${group.title}:`, list(lines), "");
  }
  // A visible command no group names still shows, so none is hidden by mistake.
  const rest = visible.filter((c) => !placed.has(c.name())).map((c) => item(helper.subcommandTerm(c), helper.subcommandDescription(c)));
  if (rest.length > 0) out.push("Other:", list(rest), "");

  const options = helper.visibleOptions(cmd).map((o) => item(helper.optionTerm(o), helper.optionDescription(o)));
  if (options.length > 0) out.push("Options:", list(options), "");
  out.push("Run `tunelo <command> --help` for a command's options.", "");
  return out.join("\n");
}
