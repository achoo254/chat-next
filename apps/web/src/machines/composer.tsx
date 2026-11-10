// The remote chat's composer: a message goes out at once (shown until the
// machine echoes it; while a turn runs the machine queues it). One button
// sends, or stops the turn while it runs and the field is empty; Esc stops
// it too (unless a prompt above waits for an answer: Esc answers that).
// Typing "/" first opens a picker of the AI's commands and skills in this
// folder (ThreadInfo); typing "@" opens the files of the session's folder
// (FileList, tunelo 2.0.1+), and the pick goes in as "@path ".
// Files (tunelo 2.0.5+) come by the attach button, by pasting or by dropping
// them on the session; they upload at once and go with the next message,
// which may then have no text.
import { useEffect, useId, useRef, useState } from "react";
import type { SlashCommand } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { PlainTextBox, type PlainTextBoxHandle } from "../components/plain-text-box.tsx";
import { AttachButton, AttachTray } from "./attachment-tray.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import type { ShownAttachment } from "./transcript/tool-fold.ts";
import type { Attachments } from "./use-attachments.ts";
import { filterCommands, flatCommands, slashQuery } from "./slash-commands.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** Files of the session's folder matching a prefix; null when the machine cannot list them. */
export interface FileListing {
	readonly entries: readonly { readonly path: string; readonly dir: boolean }[];
	readonly truncated: boolean;
}

export type ListFiles = (prefix: string) => Promise<FileListing | null>;

interface ComposerProps {
	ai: string;
	machine: string;
	/** The link is open. */
	online: boolean;
	running: boolean;
	/** An approval or question waits above the composer (Esc answers it, not Stop). */
	prompting: boolean;
	/** The AI's slash commands and skills; empty while unknown. */
	commands: readonly SlashCommand[];
	/** Lists the session folder's files for "@"; absent when the machine cannot. */
	listFiles?: ListFiles | undefined;
	/** Files waiting for the next message; absent where the session takes none. */
	attach?: Attachments | undefined;
	onSend: (text: string, files: readonly ShownAttachment[]) => Promise<void>;
	onStop: () => Promise<void>;
}

const MENTION_DELAY_MS = 150;

/** The "@…" being typed right before the caret: its start and what follows the "@"; null when none. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
	if (match === null) return null;
	const query = match[1] ?? "";
	return { start: caret - query.length - 1, query };
}

type Option = { kind: "command"; command: SlashCommand } | { kind: "file"; path: string; dir: boolean };

/** The files found for one "@" query. */
interface Found {
	readonly query: string;
	readonly listing: FileListing;
}

export function Composer({ ai, machine, online, running, prompting, commands, listFiles, attach, onSend, onStop }: ComposerProps) {
	const t = useMachinesCopy();
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [error, setError] = useState("");
	const [stopping, setStopping] = useState(false);
	const [active, setActive] = useState(0);
	/** The text the picker was closed at (Esc); it opens again once the text changes. */
	const [closedAt, setClosedAt] = useState<string | null>(null);
	const [found, setFound] = useState<Found | null>(null);
	const field = useRef<PlainTextBoxHandle>(null);
	const listId = useId();
	const at = listFiles === undefined || closedAt === text ? null : mentionAt(text, caret);
	const query = at === null ? slashQuery(text) : null;
	const groups = query === null || closedAt === text ? null : filterCommands(commands, query);
	const files = at !== null && found !== null && found.query === at.query ? found.listing : null;
	const searching = at !== null && files === null;
	const options: Option[] =
		at !== null
			? (files?.entries ?? []).map((e) => ({ kind: "file", path: e.path, dir: e.dir }))
			: groups === null
				? []
				: flatCommands(groups).map((command) => ({ kind: "command", command }));
	const open = options.length > 0 || at !== null;
	const index = Math.min(active, Math.max(0, options.length - 1));
	const optionId = (i: number) => `${listId}-${i}`;
	const filesReady = attach !== undefined && attach.items.length > 0 && !attach.busy && !attach.failed;
	const filesWaiting = attach !== undefined && (attach.busy || attach.failed);
	const stopMode = running && text.trim() === "" && (attach?.items.length ?? 0) === 0;
	const canSend = online && !filesWaiting && (text.trim() !== "" || filesReady);

	useEffect(() => {
		if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: "nearest" });
	}, [open, index, listId]);

	// "@…": ask the machine for matching files, a moment after the typing stops.
	const mentionQuery = at?.query ?? null;
	useEffect(() => {
		if (mentionQuery === null || listFiles === undefined) return;
		let live = true;
		const none: FileListing = { entries: [], truncated: false };
		const timer = window.setTimeout(() => {
			listFiles(mentionQuery).then(
				(listing) => {
					if (live) setFound({ query: mentionQuery, listing: listing ?? none });
				},
				() => {
					if (live) setFound({ query: mentionQuery, listing: none });
				},
			);
		}, MENTION_DELAY_MS);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [mentionQuery, listFiles]);

	const edit = (value: string, nextCaret = value.length) => {
		setText(value);
		setCaret(nextCaret);
		setActive(0);
	};
	/** Puts text in place of [start, end) as typed, so the caret lands after it and undo takes it back. */
	const replace = (start: number, end: number, inserted: string) => {
		const box = field.current;
		if (box === null) {
			edit(text.slice(0, start) + inserted + text.slice(end), start + inserted.length);
			return;
		}
		box.focus();
		box.setSelection(start, end);
		box.insertText(inserted);
	};
	const pick = (option: Option) => {
		if (option.kind === "command") {
			replace(0, text.length, `/${option.command.name} `);
			return;
		}
		if (at === null) return;
		replace(at.start, caret, option.dir ? `@${option.path}` : `@${option.path} `);
	};
	const send = () => {
		const message = text.trim();
		if (!canSend) return;
		const files = attach?.take() ?? [];
		edit("");
		setError("");
		onSend(message, files).then(
			() => attach?.sent(files),
			() => {
				// Put the text and the files back so nothing is lost.
				setText((current) => (current === "" ? message : current));
				attach?.putBack(files);
				setError(t.chat.sendFailed);
			},
		);
		field.current?.focus();
	};
	const onPaste = (event: ClipboardEvent) => {
		const clipboard = event.clipboardData;
		const pasted = [...(clipboard?.files ?? [])];
		// Copied text that also carries a file (a cell, a rich document): the text goes in as usual.
		if (pasted.length === 0 || clipboard?.getData("text/plain") !== "" || attach === undefined) return;
		event.preventDefault();
		attach.add(pasted);
	};
	const stop = () => {
		if (stopping) return;
		setStopping(true);
		onStop()
			.catch(() => setError(t.errors.offline))
			.finally(() => setStopping(false));
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (open) {
			const picked = options[index];
			if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive((index + step + options.length) % options.length);
				return;
			}
			if (((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) && picked !== undefined) {
				event.preventDefault();
				pick(picked);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setClosedAt(text);
				return;
			}
		}
		if (event.key === "Escape" && running && !prompting && online) {
			event.preventDefault();
			stop();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	};

	const commandOption = (option: Option, i: number) => {
		if (option.kind !== "command") return null;
		const command = option.command;
		return (
			// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- options never take focus: the text box handles the arrow keys, Tab, Enter and Esc for this listbox
			<li
				key={command.name}
				id={optionId(i)}
				role="option"
				aria-selected={i === index}
				className={i === index ? "active" : undefined}
				// Keep the focus (and the phone keyboard) in the field.
				onPointerDown={(event) => event.preventDefault()}
				onPointerMove={() => i !== index && setActive(i)}
				onClick={() => pick(option)}
			>
				<span className="cmd">
					<b>/{command.name}</b>
					{command.argumentHint !== "" && <span className="arg">{command.argumentHint}</span>}
				</span>
				{command.description !== "" && <small>{command.description}</small>}
			</li>
		);
	};

	/** One group of commands; `offset` is the index of its first option in keyboard order. */
	const group = (label: string, list: readonly SlashCommand[], key: string, offset: number) =>
		list.length === 0 ? null : (
			<li role="presentation" key={key}>
				<div className="mx-slash-head" id={`${listId}-${key}`} role="presentation">
					{label}
				</div>
				<ul role="group" aria-labelledby={`${listId}-${key}`}>
					{list.map((command, n) => commandOption({ kind: "command", command }, offset + n))}
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
			{attach !== undefined && <AttachTray attach={attach} />}
			<div className="mx-compose-row">
				{attach?.supported === true && <AttachButton attach={attach} disabled={!online} />}
				{open && at === null && groups !== null && (
					<ul className="mx-slash" id={listId} role="listbox" aria-label={t.slash.label}>
						{group(t.slash.builtin(ai), groups.builtin, "builtin", 0)}
						{group(t.slash.skills, groups.skills, "skills", groups.builtin.length)}
					</ul>
				)}
				{open && at !== null && (
					<ul className="mx-slash" id={listId} role="listbox" aria-label={t.agent.mention.label} aria-busy={searching}>
						{options.length === 0 && (
							<li role="presentation" className="mx-slash-head">
								{searching ? t.agent.mention.loading : t.agent.mention.none}
							</li>
						)}
						{options.map((option, i) =>
							option.kind === "file" ? (
								// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- options never take focus: the text box handles the keys for this listbox
								<li
									key={option.path}
									id={optionId(i)}
									role="option"
									aria-selected={i === index}
									className={i === index ? "active file" : "file"}
									onPointerDown={(event) => event.preventDefault()}
									onPointerMove={() => i !== index && setActive(i)}
									onClick={() => pick(option)}
								>
									<span className="cmd">
										<MachineIcon name={option.dir ? "folder" : "list"} small />
										<b>{option.path}</b>
									</span>
								</li>
							) : null,
						)}
						{files?.truncated === true && (
							<li role="presentation" className="mx-slash-head">
								{t.agent.mention.more}
							</li>
						)}
					</ul>
				)}
				<PlainTextBox
					ref={field}
					className="mx-field"
					data-composer=""
					ariaLabel={t.chat.message}
					aria-autocomplete="list"
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open && options.length > 0 ? optionId(index) : undefined}
					enterKeyHint="send"
					placeholder={t.chat.placeholder(ai, machine)}
					value={text}
					disabled={!online}
					onValueChange={(value, selection) => edit(value, selection.start)}
					onSelectionChange={(selection) => setCaret(selection.start)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
				{stopMode ? (
					<button type="button" className="icon-btn mx-send stop" aria-label={t.chat.stop} title={t.chat.stop} disabled={!online || stopping} onClick={stop}>
						<MachineIcon name="stop" />
					</button>
				) : (
					<button
						type="button"
						className="icon-btn mx-send"
						aria-label={running ? t.agent.composer.queue : t.chat.send}
						title={filesWaiting ? t.agent.attach.waitUpload : `${running ? t.agent.composer.queue : t.chat.send} · ${t.agent.composer.keys}`}
						disabled={!canSend}
						onClick={send}
					>
						<Icon name="send" />
					</button>
				)}
			</div>
		</div>
	);
}
