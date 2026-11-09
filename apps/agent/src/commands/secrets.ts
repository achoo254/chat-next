// `tunelo secrets list|remove <id>`: the sign-in secrets the machine keeps
// for Claude (sign-in-secrets/secret-store.ts), by site and name. Values are never
// printed: the list only says what is kept and when it was last used.
// Removing works on the file itself, so the running service sees it on its
// next use; every removal goes to the consent log.
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { AuditLog } from "../safety/audit-log.ts";
import { type SavedSecretInfo, listSavedSecrets, removeSavedSecret } from "../sign-in-secrets/secret-store.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

const when = (ms: number) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "never");

export function secretLines(secrets: readonly SavedSecretInfo[]): string[] {
	if (secrets.length === 0) return ["No sign-in secrets are kept on this machine."];
	return secrets.map((s) => `${s.id}  ${s.origin}  ${s.name}  (saved ${when(s.createdAt)}, last used ${when(s.lastUsedAt)})`);
}

export async function runSecrets(action: string, id: string | undefined, dir: string, print: (line: string) => void): Promise<number> {
	if (action === "list") {
		for (const line of secretLines(listSavedSecrets(dir))) print(line);
		return 0;
	}
	if (action === "remove") {
		if (!id) throw new Error("say which one: tunelo secrets remove <id> (ids from `tunelo secrets list`)");
		const gone = removeSavedSecret(dir, id);
		if (!gone) throw new Error(`no secret ${id} is kept on this machine`);
		new AuditLog(join(dir, "audit.jsonl")).write({ device: "local", action: "secret_remove", path: gone.origin, detail: gone.name });
		print(`Removed ${gone.name} for ${gone.origin}.`);
		return 0;
	}
	throw new Error(`unknown action ${action}: use list or remove <id>`);
}

export function registerSecretsCommand(program: Command, exits: Exits): void {
	const secrets = program.command("secrets").description("sign-in secrets kept for Claude on this machine (values are never shown)");
	secrets
		.command("list")
		.description("list them: id, site, name, last use")
		.action(exits(() => runSecrets("list", undefined, configDir(), (line) => console.log(line))));
	secrets
		.command("remove <id>")
		.description("forget one (id from `tunelo secrets list`)")
		.action(exits((id: string) => runSecrets("remove", id, configDir(), (line) => console.log(line))));
}
