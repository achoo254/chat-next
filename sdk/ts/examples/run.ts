// Shared runner of the example bots. Environment:
//   BOT_TOKEN       bot token (required; never printed)
//   BOT_API         Bot API base URL of the chat server (required), e.g. https://chat.example.com/bot/v1
//   BOT_MODE        poll (default) or webhook
//   WEBHOOK_PORT    port to listen on (webhook mode)
//   WEBHOOK_SECRET  secret given to setWebhook and checked on every request
//   WEBHOOK_URL     public URL the server POSTs updates to
// Prints exactly one line "ready" to stdout once updates can be received;
// everything else goes to stderr.

import { createServer } from "node:http";
import { Bot, Client } from "../src/index.ts";

/** Builds the bot, lets `setup` add handlers (and startup calls), then serves it. */
export async function run(setup: (bot: Bot) => void | Promise<void>): Promise<void> {
	try {
		await serve(setup);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

async function serve(setup: (bot: Bot) => void | Promise<void>): Promise<void> {
	const token = required("BOT_TOKEN");
	const mode = process.env["BOT_MODE"] || "poll";
	if (mode !== "poll" && mode !== "webhook") {
		throw new Error(`BOT_MODE must be poll or webhook, not "${mode}"`);
	}
	const bot = new Bot(new Client(token, { baseUrl: required("BOT_API") }));
	await setup(bot);
	await bot.init();

	if (mode === "poll") {
		await bot.client.deleteWebhook();
		const stop = new AbortController();
		onSignal(() => stop.abort());
		console.log("ready");
		await bot.poll({ signal: stop.signal });
		return;
	}

	const port = Number(required("WEBHOOK_PORT"));
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error("WEBHOOK_PORT must be a port number");
	}
	const secret = required("WEBHOOK_SECRET");
	const url = required("WEBHOOK_URL");
	const server = createServer(bot.webhookHandler(secret));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => {
			server.off("error", reject);
			resolve();
		});
	});
	onSignal(() => {
		server.close();
		server.closeAllConnections();
	});
	await bot.client.setWebhook({ url, secret });
	console.log("ready");
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error(`${name} is not set`);
	}
	return value;
}

function onSignal(stop: () => void): void {
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, stop);
	}
}
