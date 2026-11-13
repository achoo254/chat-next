// "Opus 4.7 ▾" in the status bar: the AI's models and effort levels, and
// switching to another AI when the machine has two or more.
import { useState } from "react";
import { LoginState, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { aiName, errorText, modelName, providerOf, readableModel } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

interface ModelMenuProps {
	link: MachineLink;
	info: MachineInfo | null;
	threadId: string;
	provider: string;
	model: string;
	/** The model that answered the latest turn (the default resolved); "" when none did yet. */
	answered: string;
	/** The session's effort; "" for the machine's default. */
	effort: string;
	disabled: boolean;
}

export function ModelMenu({ link, info, threadId, provider, model, answered, effort, disabled }: ModelMenuProps) {
	const t = useMachinesCopy();
	const { open, setOpen, ref: menu } = usePopover();
	const [switchTo, setSwitchTo] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const ai = aiName(info, provider);
	const caps = providerOf(info, provider)?.capabilities;
	const models = caps?.models ?? [];
	const efforts = caps?.effortLevels ?? [];
	const others = (info?.providers ?? []).filter((p) => p.id !== provider);
	const run = (body: Parameters<MachineLink["request"]>[0], done: () => void) => {
		setBusy(true);
		setError("");
		link.request(body).then(
			() => {
				setBusy(false);
				done();
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	const many = (info?.providers.length ?? 0) > 1;
	// The default says which model it is once a turn has answered: "mặc định · Opus 5.5".
	const resolved = answered === "" ? "" : readableModel(answered);
	const name = model !== "" ? modelName(info, provider, model) : resolved === "" ? t.statusBar.defaultModel : t.statusBar.defaultIs(resolved);
	const label = many ? `${ai} · ${name}` : name;
	return (
		<div className="mx-model" ref={menu}>
			<button
				type="button"
				className="mx-st-btn"
				title={t.statusBar.model(label)}
				aria-label={t.statusBar.model(label)}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
			>
				<MachineIcon name="cpu" small />
				<span>{name}</span>
				<MachineIcon name="chevron-down" small />
			</button>
			{open && (
				<div className="mx-menu up" role="menu" aria-label={t.chat.modelMenu}>
					<h5>{t.chat.modelsOf(ai)}</h5>
					{model === "" && (
						// The machine's default, checked, saying which model it is now (as the effort's default row).
						<button type="button" role="menuitemradio" aria-checked disabled={busy} onClick={() => setOpen(false)}>
							<Icon name="check" small />
							<span>
								{t.chat.effortDefault}
								{resolved !== "" && <small>{t.chat.defaultNow(resolved)}</small>}
							</span>
						</button>
					)}
					{models.map((m) => (
						<button
							key={m.id}
							type="button"
							role="menuitemradio"
							aria-checked={m.id === model}
							disabled={busy}
							onClick={() => run({ case: "threadSetModel", value: { threadId, model: m.id } }, () => setOpen(false))}
						>
							{m.id === model ? <Icon name="check" small /> : <span className="mx-menu-gap" />}
							<span>{m.name || m.id}</span>
						</button>
					))}
					{efforts.length > 0 && (
						<>
							<hr />
							<h5>{t.chat.effort}</h5>
							{["", ...efforts].map((level) => (
								<button
									key={level || "default"}
									type="button"
									role="menuitemradio"
									aria-checked={level === effort}
									disabled={busy}
									onClick={() => run({ case: "threadSetEffort", value: { threadId, effort: level } }, () => setOpen(false))}
								>
									{level === effort ? <Icon name="check" small /> : <span className="mx-menu-gap" />}
									<span>{level === "" ? t.chat.effortDefault : (t.chat.efforts[level] ?? level)}</span>
								</button>
							))}
						</>
					)}
					{others.length > 0 && (
						<>
							<hr />
							<h5>{t.chat.switchAi}</h5>
							{others.map((p) => {
								const usable = p.loginState !== LoginState.NEEDS_LOGIN;
								return (
									<button
										key={p.id}
										type="button"
										role="menuitem"
										disabled={busy || !usable}
										onClick={() => {
											setOpen(false);
											setSwitchTo(p.id);
										}}
									>
										<MachineIcon name="chevron-right" small />
										<span>
											{p.name || p.id}
											<small>{usable ? t.chat.switchHint : t.newSession.needsLogin}</small>
										</span>
									</button>
								);
							})}
						</>
					)}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
			{switchTo !== null && (
				<ConfirmDialog
					title={t.chat.switchTitle(aiName(info, switchTo))}
					body={
						<>
							<p>{t.chat.switchBody(aiName(info, switchTo))}</p>
							{error !== "" && (
								<p className="mx-error" role="alert">
									{error}
								</p>
							)}
						</>
					}
					action={t.chat.switchAction}
					busyLabel={t.chat.switching}
					busy={busy}
					danger={false}
					onConfirm={() => run({ case: "threadSwitch", value: { threadId, provider: switchTo, model: "" } }, () => setSwitchTo(null))}
					onClose={() => setSwitchTo(null)}
				/>
			)}
		</div>
	);
}
