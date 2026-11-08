// `tunelo claude profiles [list|add|select|remove]`: the Claude accounts of
// this machine, from its own terminal. `add` runs claude's sign-in right in
// this terminal (the browser opens here), in a folder the service prepared;
// the service then keeps the profile unless that account is already there.
// It is also the way when a device cannot sign in for the machine.
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { claudeEnv } from "../profiles/account.ts";
import type { ProfileList, ProfileView, SignInOutcome } from "../profiles/service.ts";
import { findClaude } from "../providers/claude/index.ts";

const MESSAGES: Record<string, string> = {
  duplicate: "This Claude account is already on this machine; nothing was added.",
  expired: "The sign-in took too long or another one started; run the command again.",
  "code-rejected": "Claude did not accept the sign-in; run the command again.",
  failed: "Claude did not report a signed-in account; nothing was added.",
  busy: "A sign-in is already finishing; try again in a moment.",
};

const percent = (w?: { utilization: number }) => (w ? `${w.utilization}%` : "?");

function line(p: ProfileView, selected: boolean): string {
  const who = p.signedIn ? `${p.email}${p.organization ? ` · ${p.organization}` : ""}${p.plan ? ` · ${p.plan}` : ""}` : "(not signed in)";
  const usage = p.lastUsage
    ? `  5h ${percent(p.lastUsage.fiveHour)}, week ${percent(p.lastUsage.sevenDay)} (at ${new Date(p.lastUsage.updatedAt).toLocaleString()})`
    : "";
  return `${selected ? "*" : " "} ${p.id === "" ? "default " : p.id.slice(0, 8)}  ${who}${usage}`;
}

async function list(): Promise<number> {
  const l = (await callControl(configDir(), "GET", "/claude/profiles")) as ProfileList;
  for (const p of l.profiles) console.log(line(p, p.id === l.selectedId));
  console.log("* new sessions use this one; open sessions keep theirs until they open again.");
  return 0;
}

/** A profile named by "default", its id (or the first characters of it), or its e-mail. */
async function resolveProfile(name: string): Promise<string> {
  if (name === "default") return "";
  const l = (await callControl(configDir(), "GET", "/claude/profiles")) as ProfileList;
  const hits = l.profiles.filter((p) => p.id !== "" && (p.id.startsWith(name) || p.email.toLowerCase() === name.toLowerCase()));
  if (hits.length === 1 && hits[0]) return hits[0].id;
  throw new Error(hits.length === 0 ? `no profile "${name}" (see \`tunelo claude profiles\`)` : `"${name}" names more than one profile; give more of its id`);
}

async function add(): Promise<number> {
  const bin = await findClaude();
  if (!bin) throw new Error("claude is not installed on this machine");
  const dir = configDir();
  const { id, home } = (await callControl(dir, "POST", "/claude/profiles/prepare")) as { id: string; home: string };
  console.log("Signing in a new Claude account; follow claude's steps below.");
  const r = spawnSync(bin, ["auth", "login", "--claudeai"], { stdio: "inherit", env: claudeEnv(home) });
  if (r.error || r.status !== 0) {
    await callControl(dir, "POST", "/claude/profiles/cancel", { id }).catch(() => undefined);
    console.error("The sign-in did not finish; nothing was added.");
    return 1;
  }
  const out = (await callControl(dir, "POST", "/claude/profiles/finish", { id })) as SignInOutcome;
  if (!out.ok) {
    console.error(MESSAGES[out.error] ?? "The profile was not added.");
    return 1;
  }
  console.log(`Added ${out.email}${out.organization ? ` (${out.organization})` : ""}. Pick it with \`tunelo claude profiles select ${out.email}\`.`);
  return 0;
}

async function select(name: string): Promise<number> {
  const id = await resolveProfile(name);
  await callControl(configDir(), "POST", "/claude/profiles/select", { id });
  console.log(`New sessions now use ${id === "" ? "the default profile" : name}; open sessions keep theirs until they open again.`);
  return 0;
}

async function remove(name: string): Promise<number> {
  const id = await resolveProfile(name);
  if (id === "") throw new Error("the default profile cannot be removed");
  await callControl(configDir(), "POST", "/claude/profiles/remove", { id });
  console.log("Signed out and removed. The shared Claude folder (projects, history, settings) is untouched.");
  return 0;
}

export function registerProfilesCommand(program: Command, exits: <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>): void {
  const profiles = program
    .command("claude")
    .description("the Claude accounts of this machine")
    .command("profiles")
    .description("list, add, pick or remove Claude accounts (profiles)");
  profiles.command("list", { isDefault: true }).description("list the profiles and which one new sessions use").action(exits(list));
  profiles.command("add").description("sign in another Claude account, in this terminal").action(exits(add));
  profiles
    .command("select <profile>")
    .description('pick the profile of new sessions: "default", an id or an e-mail')
    .action(exits(select));
  profiles
    .command("remove <profile>")
    .description("sign a profile out and delete its folder (an id or an e-mail)")
    .action(exits(remove));
}
