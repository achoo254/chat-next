// `tunelo authenticator`: makes the authenticator (TOTP) secret on this
// machine and shows it once, as a QR code and as a setup key, so the first
// device can pair by the 6-digit code without another paired device and
// without installing again. The secret is made by the running service and
// reaches only this terminal: the Chat server never sees it. Run again with
// --replace to get a new one (the old code stops working).
import type { Command } from "commander";
import { encode } from "uqr";
import { configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

const BLACK_ON_WHITE = "\u001B[30;47m";
const RESET = "\u001B[0m";

/** The QR as terminal lines: black modules on a white ground, two rows per line, readable on light and dark terminals. */
export function qrLines(text: string): string[] {
	const modules = encode(text, { border: 2 }).data;
	const lines: string[] = [];
	for (let y = 0; y < modules.length; y += 2) {
		const top = modules[y] ?? [];
		const bottom = modules[y + 1] ?? [];
		let line = "";
		for (let x = 0; x < top.length; x++) {
			const t = top[x] === true;
			const b = bottom[x] === true;
			line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
		}
		lines.push(`${BLACK_ON_WHITE}${line}${RESET}`);
	}
	return lines;
}

/** The setup key in groups of four, as authenticator apps show it. */
export function groupedKey(secret: string): string {
	return secret.replace(/(.{4})/g, "$1 ").trim();
}

interface Enrolled {
	uri: string;
	secret: string;
}

export async function runAuthenticator(options: { replace?: boolean }, dir: string, print: (line: string) => void): Promise<number> {
	const made = (await callControl(dir, "POST", "/totp/enroll", { replace: options.replace === true })) as Enrolled;
	print("Open your Authenticator app, add an account and scan this code:");
	print("");
	for (const line of qrLines(made.uri)) print(line);
	print("");
	print(`Cannot scan? Enter this setup key by hand (time-based): ${groupedKey(made.secret)}`);
	print("");
	print("Then, in AI Agent, open this machine, press “Ghép thiết bị này” and type the 6 digits the app shows.");
	print("This key is shown once. Lost it? Run `tunelo authenticator --replace`.");
	return 0;
}

export function registerAuthenticatorCommand(program: Command, exits: Exits): void {
	program
		.command("authenticator")
		.description("make the authenticator code that pairs the first device with this machine (shown once as a QR code)")
		.option("--replace", "make a new one when this machine already has one (the old code stops working)")
		.action(exits((options: { replace?: boolean }) => runAuthenticator(options, configDir(), (line) => console.log(line))));
}
