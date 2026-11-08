// The remote chat's composer: a message goes out at once (shown until the
// machine echoes it; while a turn runs the machine queues it), Stop
// interrupts the turn. Typing "/" first opens a picker of the AI's commands
// and skills in this folder (ThreadInfo); the pick goes in as "/name " and
// the message is sent as plain text, which the AI runs as the command.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { SlashCommand } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { filterCommands, flatCommands, slashQuery } from "./slash-commands.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface ComposerProps {
	ai: string;
	machine: string;
	/** The link is open. */
	online: boolean;
	running: boolean;
	/** The AI's slash commands and skills; empty while unknown. */
	commands: readonly SlashCommand[];
	onSend: (text: string) => Promise<void>;
	onStop: () => Promise<void>;
}

export function Composer({ ai, machine, online, running, commands, onSend, onStop }: ComposerProps) {
	const t = useMachinesCopy();
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [stopping, setStopping] = useState(false);
	const [active, setActive] = useState(0);
	/** The text the picker was closed at (Esc); it opens again once the text changes. */
	const [closedAt, setClosedAt] = useState<string | null>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	const query = slashQuery(text);
	const groups = query === null || closedAt === text ? null : filterCommands(commands, query);
	const options = groups === null ? [] : flatCommands(groups);
	const open = options.length > 0;
	const index = Math.min(active, options.length - 1);
	const optionId = (i: number) => `${listId}-${i}`;

	useEffect(() => {
		if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: "nearest" });
	}, [open, index, listId]);

	const edit = (value: string) => {
		setText(value);
		setActive(0);
	};
	const pick = (command: SlashCommand) => {
		edit(`/${command.name} `);
		field.current?.focus();
	};
	const send = () => {
		const message = text.trim();
		if (message === "" || !online) return;
		edit("");
		setError("");
		onSend(message).catch(() => {
			// Put the text back so nothing typed is lost.
			setText((current) => (current === "" ? message : current));
			setError(t.chat.sendFailed);
		});
		field.current?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (open) {
			const picked = options[index];
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive((index + step + options.length) % options.length);
				return;
			}
			if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
				event.preventDefault();
				if (picked !== undefined) pick(picked);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setClosedAt(text);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	};

	/** One group of options; `offset` is the index of its first option in keyboard order. */
	const group = (label: string, list: readonly SlashCommand[], key: string, offset: number) =>
		list.length === 0 ? null : (
			<li role="presentation" key={key}>
				<div className="mx-slash-head" id={`${listId}-${key}`} role="presentation">
					{label}
				</div>
				<ul role="group" aria-labelledby={`${listId}-${key}`}>
					{list.map((command, n) => {
						const i = offset + n;
						return (
							// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- options never take focus: the textarea handles the arrow keys, Tab, Enter and Esc for this listbox
							<li
								key={command.name}
								id={optionId(i)}
								role="option"
								aria-selected={i === index}
								className={i === index ? "active" : undefined}
								// Keep the focus (and the phone keyboard) in the field.
								onPointerDown={(event) => event.preventDefault()}
								onPointerMove={() => i !== index && setActive(i)}
								onClick={() => pick(command)}
							>
								<span className="cmd">
									<b>/{command.name}</b>
									{command.argumentHint !== "" && <span className="arg">{command.argumentHint}</span>}
								</span>
								{command.description !== "" && <small>{command.description}</small>}
							</li>
						);
					})}
				</ul>
			</li>
		);

	return (
		<div className={online ? "mx-composer" : "mx-composer disabled"}>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			<div className="mx-compose-row">
				{open && groups !== null && (
					<ul className="mx-slash" id={listId} role="listbox" aria-label={t.slash.label}>
						{group(t.slash.builtin(ai), groups.builtin, "builtin", 0)}
						{group(t.slash.skills, groups.skills, "skills", groups.builtin.length)}
					</ul>
				)}
				<textarea
					ref={field}
					rows={1}
					className="mx-field"
					aria-label={t.chat.message}
					aria-autocomplete="list"
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open ? optionId(index) : undefined}
					placeholder={t.chat.placeholder(ai, machine)}
					value={text}
					disabled={!online}
					onChange={(event) => edit(event.target.value)}
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
			<p className="mx-compose-hint">{t.chat.keys}</p>
		</div>
	);
}
