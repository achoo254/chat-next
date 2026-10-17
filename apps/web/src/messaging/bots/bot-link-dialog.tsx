// A bot link (https://chat.<domain>/b/<username>?start=<param>, mockups/
// bots.html#deep-link): nothing is sent until the user agrees. The dialog
// names the bot and shows the exact start command; "Gửi /start" records the
// consent, opens the private chat and sends the command (StartBot); Huỷ sends
// nothing.
import { useEffect, useState } from "react";
import { cryptoRandomId } from "@app/platform";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { orgDomain } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import { validStartParam, type BotInfo } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./bot-chat.css";

/** "/start" or "/start <param>": what the bot receives. */
export function startCommand(startParam: string): string {
	return startParam === "" ? "/start" : `/start ${startParam}`;
}

export default function BotLinkDialog({ username, startParam }: { username: string; startParam: string }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const [bot, setBot] = useState<BotInfo | null>(null);
	const [busy, setBusy] = useState(false);
	// One id for this dialog: pressing again after a failure cannot send /start twice.
	const [randomId] = useState(cryptoRandomId);
	const id = useDomId("bot-link");
	const valid = validStartParam(startParam);

	useEffect(() => {
		if (!valid) {
			toasts.show(t.link.badLink);
			navigate(paths.home, { replace: true });
			return;
		}
		let active = true;
		bots.resolve(username).then(
			(found) => {
				if (!active) return;
				if (found === null) {
					toasts.show(t.link.notFound);
					navigate(paths.home, { replace: true });
				} else setBot(found);
			},
			() => {
				if (!active) return;
				toasts.show(copy.common.failed);
				navigate(paths.home, { replace: true });
			},
		);
		return () => {
			active = false;
		};
	}, [bots, toasts, username, valid, t, copy]);

	if (bot === null) return null;
	const command = startCommand(startParam);
	const cancel = () => {
		toasts.show(t.link.cancelled);
		navigate(paths.home, { replace: true });
	};
	const send = async () => {
		setBusy(true);
		try {
			const chatId = await bots.start(bot.id, startParam, randomId);
			navigate(paths.chat(chatId), { replace: true });
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};
	return (
		<Modal labelledBy={id} onClose={cancel}>
			<DialogHead id={id} title={t.link.title(bot.name)} onClose={cancel} />
			<div className="dlg-body stack">
				<div className="bot-line">
					<ChatAvatar id={bot.id} name={bot.name} bot />
					<div>
						<strong>{bot.name}</strong>
						<small>{t.link.botLine(bot.username, orgDomain(window.location.host))}</small>
					</div>
				</div>
				{bot.description !== "" && <p className="bot-desc">{bot.description}</p>}
				<p className="link-ask">
					<strong>{t.link.ask(command, bot.name)}</strong>
				</p>
				<code className="param">{command}</code>
				<p className="note">
					<Icon name="lock" small />
					<span>{t.link.fine}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={cancel}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={() => void send()}>
					{busy ? t.link.sending : t.link.send}
				</button>
			</div>
		</Modal>
	);
}
