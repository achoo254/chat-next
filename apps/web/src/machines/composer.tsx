// The remote chat's composer: a message goes out at once (shown until the
// machine echoes it; while a turn runs the machine queues it), Stop
// interrupts the turn. The session always asks before tools run: the chip
// says so and there is no way to change it from here.
import { useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface ComposerProps {
	ai: string;
	machine: string;
	/** The link is open. */
	online: boolean;
	running: boolean;
	onSend: (text: string) => Promise<void>;
	onStop: () => Promise<void>;
}

export function Composer({ ai, machine, online, running, onSend, onStop }: ComposerProps) {
	const t = useMachinesCopy();
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [stopping, setStopping] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	const send = () => {
		const message = text.trim();
		if (message === "" || !online) return;
		setText("");
		setError("");
		onSend(message).catch(() => {
			// Put the text back so nothing typed is lost.
			setText((current) => (current === "" ? message : current));
			setError(t.chat.sendFailed);
		});
		field.current?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};
	return (
		<div className={online ? "mx-composer" : "mx-composer disabled"}>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			<div className="mx-compose-row">
				<textarea
					ref={field}
					rows={1}
					className="mx-field"
					aria-label={t.chat.message}
					placeholder={t.chat.placeholder(ai, machine)}
					value={text}
					disabled={!online}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
				/>
				{running && (
					<button
						type="button"
						className="icon-btn mx-stop"
						aria-label={t.chat.stop}
						disabled={!online || stopping}
						onClick={() => {
							setStopping(true);
							onStop()
								.catch(() => setError(t.errors.offline))
								.finally(() => setStopping(false));
						}}
					>
						<MachineIcon name="stop" />
					</button>
				)}
				<button type="button" className="icon-btn mx-send" aria-label={t.chat.send} disabled={!online || text.trim() === ""} onClick={send}>
					<Icon name="send" />
				</button>
			</div>
			<p className="mx-compose-hint">
				<span className="mx-mode" title={t.chat.alwaysAskHint}>
					{t.chat.alwaysAsk}
				</span>
				<span className="hide-narrow">{t.chat.keys}</span>
			</p>
		</div>
	);
}
