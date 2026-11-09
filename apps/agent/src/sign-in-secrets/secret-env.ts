/**
 * `$TUNELO_SECRET_<NAME>` in the Bash commands of a session, without the
 * value ever being in the command Claude wrote, in argv, or in a transcript.
 *
 * Claude Code runs the script named by `CLAUDE_ENV_FILE` ahead of every Bash
 * command, in the command's shell (it reads that file once per session, so
 * the file itself never changes): tunelo points it at a fixed loader that
 * sources a second file, 0600 in tunelo's data folder, when it holds
 * anything. That second file holds the secrets a command names only while
 * that command runs: written once the command may run (approved on the
 * device, or the session runs in bypassPermissions) and emptied when it ends,
 * failed or was denied. Commands running at the same time share it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envNamesIn } from "./secret-names.ts";
import type { SecretService, SecretSession } from "./secret-service.ts";

/** A path as the shell reads it in single quotes (Git Bash on Windows takes forward slashes). */
function shellPath(path: string): string {
	return `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

function shellValue(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What tunelo's hooks need of a session's secrets. */
export interface SessionSecretHooks {
	/** For CLAUDE_ENV_FILE. */
	readonly loader: string;
	/** The secret names a command reads that this session was given, and those it was not. */
	namesIn(command: string): { given: string[]; missing: string[] };
	/** Every secret name a command reads, with the site of the one this session holds ("" when it holds none). */
	sitesIn(command: string): { name: string; origin: string }[];
	/** The command may run now: its secrets are put where its shell loads them. */
	beforeCommand(toolUseId: string, command: string): Promise<void>;
	/** The command ended, failed or was denied: its secrets leave the file. */
	afterCommand(toolUseId: string): void;
	dispose(): void;
}

export class SessionSecretEnv implements SessionSecretHooks {
	readonly loader: string;
	private readonly values: string;
	private readonly running = new Map<string, Record<string, string>>();

	constructor(
		private readonly service: SecretService,
		private readonly session: SecretSession,
		dataDir: string,
		/** A CLAUDE_ENV_FILE the machine already had: still loaded. */
		previous = process.env.CLAUDE_ENV_FILE,
	) {
		const dir = join(dataDir, "secret-env");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const id = randomBytes(9).toString("base64url");
		this.loader = join(dir, `${id}.sh`);
		this.values = join(dir, `${id}.vars`);
		writeFileSync(this.values, "", { mode: 0o600 });
		const lines = [
			...(previous ? [`[ -r ${shellPath(previous)} ] && . ${shellPath(previous)}`] : []),
			`[ -s ${shellPath(this.values)} ] && . ${shellPath(this.values)}`,
			"true",
		];
		writeFileSync(this.loader, `${lines.join("\n")}\n`, { mode: 0o600 });
	}

	namesIn(command: string): { given: string[]; missing: string[] } {
		const names = envNamesIn(command);
		return {
			given: names.filter((n) => this.service.hasName(this.session.key, n)),
			missing: names.filter((n) => !this.service.hasName(this.session.key, n)),
		};
	}

	sitesIn(command: string): { name: string; origin: string }[] {
		return envNamesIn(command).map((name) => ({ name, origin: this.service.originOf(this.session.key, name) ?? "" }));
	}

	async beforeCommand(toolUseId: string, command: string): Promise<void> {
		const { given } = this.namesIn(command);
		if (given.length === 0) return;
		const { env } = await this.service.envFor(this.session, given);
		this.running.set(toolUseId, env);
		this.write();
	}

	afterCommand(toolUseId: string): void {
		if (!this.running.delete(toolUseId)) return;
		this.write();
	}

	private write(): void {
		const merged: Record<string, string> = {};
		for (const env of this.running.values()) Object.assign(merged, env);
		const text = Object.entries(merged)
			.map(([k, v]) => `export ${k}=${shellValue(v)}`)
			.join("\n");
		writeFileSync(this.values, text ? `${text}\n` : "", { mode: 0o600 });
	}

	dispose(): void {
		this.running.clear();
		rmSync(this.values, { force: true });
		rmSync(this.loader, { force: true });
	}
}
