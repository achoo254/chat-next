// Mini App bot: /start sends a button that opens the shop's Mini App; a
// small HTTP server is the Mini App's backend: POST /verify takes the raw
// init data and answers who opened it (401 when it is not genuine). Data the
// Mini App sends back arrives as web_app_data and is confirmed in the chat.
// Environment (besides run.ts): MINI_APP_URL (https, on your own domain),
// MINI_APP_PORT (port of the backend).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Client, type MiniAppInitData, verifyMiniAppInitData } from "../src/index.ts";
import { run } from "./run.ts";

const MINI_APP_URL = process.env["MINI_APP_URL"] || "https://shop.example.com/app";
const MINI_APP_PORT = Number(process.env["MINI_APP_PORT"] || "8081");
/** Init data is a short query string; anything bigger is refused unread. */
const MAX_BODY = 8 * 1024;

await run(async (bot) => {
	if (!Number.isInteger(MINI_APP_PORT) || MINI_APP_PORT <= 0 || MINI_APP_PORT > 65535) {
		throw new Error("MINI_APP_PORT must be a port number");
	}
	const me = await bot.init();
	const verify = verifier(bot.client, me.id);
	const server = createServer((req, res) => {
		handleVerify(req, res, verify).catch((error: unknown) => {
			console.error("verify:", error instanceof Error ? error.message : String(error));
			if (!res.headersSent) {
				res.writeHead(500).end();
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(MINI_APP_PORT, () => {
			server.off("error", reject);
			resolve();
		});
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			server.close();
			server.closeAllConnections();
		});
	}

	bot.command("start", (ctx) =>
		ctx.reply("Mở cửa hàng để đặt món:", {
			reply_markup: { inline_keyboard: [[{ text: "Mở cửa hàng", web_app: { url: MINI_APP_URL } }]] },
		}),
	);
	bot.message(async (ctx) => {
		const sent = ctx.message?.web_app_data;
		if (sent !== undefined) {
			await ctx.reply(`Đã nhận đơn: ${sent.data}`);
		}
	});
});

/**
 * Verifies init data with the server's public key, cached; when the check
 * fails the key is fetched again once, as the server may have rotated it.
 */
function verifier(client: Client, botId: number): (initData: string) => Promise<MiniAppInitData | null> {
	let key: string | undefined;
	return async (initData) => {
		if (key !== undefined) {
			const data = verifyMiniAppInitData(initData, botId, key);
			if (data !== null) {
				return data;
			}
		}
		key = (await client.getMiniAppKey()).public_key;
		return verifyMiniAppInitData(initData, botId, key);
	};
}

async function handleVerify(
	req: IncomingMessage,
	res: ServerResponse,
	verify: (initData: string) => Promise<MiniAppInitData | null>,
): Promise<void> {
	if (req.method !== "POST" || req.url !== "/verify") {
		res.writeHead(404).end();
		return;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const part = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
		size += part.length;
		if (size > MAX_BODY) {
			res.writeHead(413).end();
			return;
		}
		chunks.push(part);
	}
	const data = await verify(Buffer.concat(chunks).toString("utf8"));
	if (data === null) {
		res.writeHead(401).end();
		return;
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ user_id: data.user.id, chat_type: data.chat_type }));
}
