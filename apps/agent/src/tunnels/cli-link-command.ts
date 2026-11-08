import { acceptsAccountToken } from "@tunelo/client";
import type { Command } from "commander";
import {
	approveLink,
	getApiBaseUrl,
	listLinks,
	revokeLink,
} from "./api-client.js";
import { type TuneloConfig, loadConfig } from "./config.js";
import { printServerMigration, resolveServerUrl } from "./server-url.js";

export const LINKS_NOT_NEEDED_MESSAGE =
	"Not needed: you are signed in, so Localman sees this machine's tunnels through your account.";
export const OTHER_SERVER_SESSION_MESSAGE =
	"Your sign-in is for another Tunelo server, so this machine's tunnels use its anonymous token. Run `tunelo login` to use your account here.";

/** Names come from the server; never let them drive the terminal. */
function printable(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function fail(message: string): never {
	console.error(`  ${message}`);
	process.exit(1);
}

export const NO_ANONYMOUS_TOKEN_MESSAGE =
	"No anonymous token on this machine. Run `tunelo login`.";

export type LinkContext =
	| { kind: "not-needed" }
	| { kind: "no-key" }
	| { kind: "anonymous"; key: string; otherServerSession: boolean };

/**
 * Same rule as `tunelo http` (`resolveCredential`): a sign-in only counts
 * when its token may go to this server. A session of another server (e.g.
 * from before a domain move) leaves the tunnels on the anonymous token, so
 * the machine still needs a link.
 */
export function linkContextOf(
	config: Pick<TuneloConfig, "session" | "key">,
	serverUrl: string,
	envKey: string | undefined,
): LinkContext {
	const session = config.session;
	if (session && acceptsAccountToken(serverUrl, session.issuer)) {
		return { kind: "not-needed" };
	}
	const key = envKey ?? config.key;
	if (!key) return { kind: "no-key" };
	return { kind: "anonymous", key, otherServerSession: Boolean(session) };
}

/**
 * Links are for machines without an account: they need the anonymous token
 * saved by an older CLI or `tunelo login --legacy-key`.
 */
function anonymousContext(): { baseUrl: string; key: string } {
	const serverUrl = resolveServerUrl(undefined, printServerMigration);
	const context = linkContextOf(
		loadConfig(),
		serverUrl,
		process.env.TUNELO_KEY,
	);
	if (context.kind === "not-needed") {
		console.log(`  ${LINKS_NOT_NEEDED_MESSAGE}`);
		process.exit(0);
	}
	if (context.kind === "no-key") {
		fail(NO_ANONYMOUS_TOKEN_MESSAGE);
	}
	if (context.otherServerSession)
		console.log(`  ${OTHER_SERVER_SESSION_MESSAGE}`);
	return { baseUrl: getApiBaseUrl(serverUrl), key: context.key };
}

export function registerLinkCommands(program: Command): void {
	program
		.command("link <code>")
		.description("Let Localman see this machine's tunnels (no account needed)")
		.action(async (code: string) => {
			const { baseUrl, key } = anonymousContext();
			try {
				const { clientName } = await approveLink(baseUrl, key, code);
				console.log(
					`  ✓ Linked ${printable(clientName) || "the client"} to this machine.`,
				);
			} catch (err) {
				fail((err as Error).message);
			}
		});

	const links = program
		.command("links")
		.description("List or revoke the links of this machine");

	links
		.command("list", { isDefault: true })
		.description("List the clients linked to this machine")
		.action(async () => {
			const { baseUrl, key } = anonymousContext();
			try {
				const rows = await listLinks(baseUrl, key);
				if (rows.length === 0) {
					console.log("  No links.");
					return;
				}
				for (const row of rows) {
					const used = row.lastUsedAt ? `, last used ${row.lastUsedAt}` : "";
					console.log(
						`  ${printable(row.id)}  ${printable(row.clientName) || "(unnamed)"}  linked ${row.createdAt ?? "?"}${used}`,
					);
				}
			} catch (err) {
				fail((err as Error).message);
			}
		});

	links
		.command("revoke <id>")
		.description("Revoke one link")
		.action(async (id: string) => {
			const { baseUrl, key } = anonymousContext();
			try {
				await revokeLink(baseUrl, key, id);
				console.log("  ✓ Link revoked.");
			} catch (err) {
				fail((err as Error).message);
			}
		});
}
