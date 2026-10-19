// Opening a Mini App: the server checks the request and signs the init data
// (BotsService.OpenMiniApp), then the screen shows the container
// (mini-app.tsx). Shared by inline Mini App buttons and "Mở app".
import type { Ui } from "../ui/ui-context.tsx";
import type { Bots } from "./api.ts";

/** What opens a Mini App: a button of the message chatId/seq, or (url "", seq 0) the bot's main one. */
export interface MiniAppTarget {
	readonly botId: number;
	readonly chatId: number;
	readonly seq: number;
	/** The button's Mini App URL; "" for the bot's main Mini App. */
	readonly url: string;
	/** Text of the button; "" for the main Mini App. */
	readonly buttonText: string;
}

let serial = 0;

/** Shows the container once the server answers; rejects (BotError) when it refuses or cannot be reached. */
export async function launchMiniApp(bots: Bots, ui: Ui, target: MiniAppTarget): Promise<void> {
	const launch = await bots.openMiniApp(target.botId, target.chatId, target.seq, target.url);
	serial += 1;
	ui.miniApp.set({ ...target, id: serial, url: launch.url, initData: launch.initData });
}
