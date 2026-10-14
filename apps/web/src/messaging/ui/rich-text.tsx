// Message text rendered from entities (ADR 0004): offsets are UTF-16 units,
// entities nest but never partially overlap. Nothing is inserted as HTML;
// every link goes through the scheme allowlist, and links off the tenant's
// own sites ask before opening.
import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { isAllowedUrl, normalizeLinkUrl, type MessageEntity } from "@app/core";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { hostOf, isTrustedHost } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { copyText } from "./parts.tsx";

const APP_SCHEME = brand.urlScheme;

interface Node {
	readonly entity: MessageEntity | null;
	readonly start: number;
	readonly end: number;
	readonly children: Node[];
}

/** Builds the entity tree; invalid or partially overlapping entities are dropped. */
export function entityTree(text: string, entities: readonly MessageEntity[]): Node {
	const root: Node = { entity: null, start: 0, end: text.length, children: [] };
	const sorted = entities
		.filter((e) => Number.isSafeInteger(e.offset) && e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length)
		.slice()
		.sort((a, b) => a.offset - b.offset || b.length - a.length);
	const stack: Node[] = [root];
	for (const entity of sorted) {
		const node: Node = { entity, start: entity.offset, end: entity.offset + entity.length, children: [] };
		let parent = stack[stack.length - 1] ?? root;
		while (stack.length > 1 && parent.end <= node.start) {
			stack.pop();
			parent = stack[stack.length - 1] ?? root;
		}
		if (node.end > parent.end) continue;
		parent.children.push(node);
		stack.push(node);
	}
	return root;
}

export interface RichContext {
	readonly selfId: number;
	readonly selfUsername: string;
	/** Opens a link, asking first when it leaves the tenant's sites; `shown` is the text the message shows for it. */
	readonly openLink: (url: string, shown?: string) => void;
}

function Spoiler({ children }: { children: ReactNode }) {
	const copy = useCopy();
	const [revealed, setRevealed] = useState(false);
	if (revealed) return <span className="spoiler revealed">{children}</span>;
	const reveal = (event: KeyboardEvent<HTMLSpanElement>) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			setRevealed(true);
		}
	};
	return (
		<span className="spoiler" role="button" tabIndex={0} aria-label={copy.message.spoiler} onClick={() => setRevealed(true)} onKeyDown={reveal}>
			<span aria-hidden="true">{children}</span>
		</span>
	);
}

function MessageLink({ url, shown = "", ctx, children }: { url: string; shown?: string; ctx: RichContext; children: ReactNode }) {
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (url.startsWith("mailto:")) return;
		event.preventDefault();
		ctx.openLink(url, shown);
	};
	return (
		<a href={url} target="_blank" rel="noopener noreferrer" onClick={onClick}>
			{children}
		</a>
	);
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
	const copy = useCopy();
	const { toasts } = useServices();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="code-block">
			<div className="cb-head">
				<span>{language}</span>
				<button
					type="button"
					className="icon-btn"
					aria-label={copied ? copy.message.codeCopied : copy.message.copyCode}
					onClick={() => {
						void copyText(code).then((ok) => {
							setCopied(ok);
							toasts.show(ok ? copy.message.codeCopied : copy.common.failed);
						});
					}}
				>
					<Icon name={copied ? "check" : "copy"} small />
				</button>
			</div>
			<pre>
				<code>{code}</code>
			</pre>
		</div>
	);
}

function renderInline(text: string, node: Node, ctx: RichContext): ReactNode[] {
	const out: ReactNode[] = [];
	let cursor = node.start;
	node.children.forEach((child, index) => {
		if (child.start > cursor) out.push(text.slice(cursor, child.start));
		out.push(<RichNode key={`${child.start}-${index}`} text={text} node={child} ctx={ctx} />);
		cursor = child.end;
	});
	if (cursor < node.end) out.push(text.slice(cursor, node.end));
	return out;
}

function RichNode({ text, node, ctx }: { text: string; node: Node; ctx: RichContext }) {
	const inner = renderInline(text, node, ctx);
	const entity = node.entity;
	const slice = text.slice(node.start, node.end);
	if (entity === null) return <>{inner}</>;
	switch (entity.type) {
		case "bold":
			return <b>{inner}</b>;
		case "italic":
			return <i>{inner}</i>;
		case "underline":
			return <u>{inner}</u>;
		case "strike":
			return <s>{inner}</s>;
		case "spoiler":
			return <Spoiler>{inner}</Spoiler>;
		case "code":
		case "pre":
			return <code>{slice}</code>;
		case "text_link":
			return entity.url !== undefined && isAllowedUrl(entity.url, APP_SCHEME) ? (
				<MessageLink url={entity.url} shown={slice} ctx={ctx}>
					{inner}
				</MessageLink>
			) : (
				<>{inner}</>
			);
		case "url": {
			const url = normalizeLinkUrl(slice, APP_SCHEME);
			return url === undefined ? <>{inner}</> : <MessageLink url={url} ctx={ctx}>{inner}</MessageLink>;
		}
		case "email":
			return isAllowedUrl(`mailto:${slice}`, APP_SCHEME) ? (
				<MessageLink url={`mailto:${slice}`} ctx={ctx}>
					{inner}
				</MessageLink>
			) : (
				<>{inner}</>
			);
		case "mention": {
			const me = ctx.selfUsername !== "" && slice.toLowerCase() === `@${ctx.selfUsername.toLowerCase()}`;
			return <span className={me ? "mention me" : "mention"}>{inner}</span>;
		}
		case "mention_name":
			return <span className={entity.userId === ctx.selfId ? "mention me" : "mention"}>{inner}</span>;
		case "hashtag":
		case "bot_command":
			return <span className="hashtag">{inner}</span>;
		case "unknown":
			return <>{inner}</>;
	}
}

/** True when the text mentions the reader (@username or a name mention). */
export function mentionsSelf(text: string, entities: readonly MessageEntity[], selfId: number, selfUsername: string): boolean {
	return entities.some((entity) => {
		if (entity.type === "mention_name") return entity.userId === selfId;
		if (entity.type !== "mention" || selfUsername === "") return false;
		return text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${selfUsername.toLowerCase()}`;
	});
}

interface RichTextProps {
	text: string;
	entities: readonly MessageEntity[];
	ctx: RichContext;
	/** Appended to the last paragraph (the time stamp). */
	tail?: ReactNode;
}

/**
 * Paragraphs and code blocks of a message. Top-level `pre` entities become
 * code blocks with a copy button; everything else stays inline.
 */
export function RichText({ text, entities, ctx, tail }: RichTextProps) {
	const root = entityTree(text, entities);
	const blocks: ReactNode[] = [];
	let inline: ReactNode[] = [];
	let cursor = 0;
	const flush = (last: boolean) => {
		if (inline.length === 0 && !last) return;
		blocks.push(
			<p key={`p${blocks.length}`}>
				{inline}
				{last ? tail : null}
			</p>,
		);
		inline = [];
	};
	root.children.forEach((child, index) => {
		if (child.start > cursor) inline.push(text.slice(cursor, child.start));
		if (child.entity?.type === "pre") {
			flush(false);
			blocks.push(
				<CodeBlock
					key={`c${child.start}`}
					code={text.slice(child.start, child.end).replace(/^\n+|\n+$/g, "")}
					language={child.entity.language ?? ""}
				/>,
			);
		} else {
			inline.push(<RichNode key={`${child.start}-${index}`} text={text} node={child} ctx={ctx} />);
		}
		cursor = child.end;
	});
	if (cursor < text.length) inline.push(text.slice(cursor));
	flush(true);
	return <>{blocks}</>;
}

/** Link opening with the trusted-host rule; `ask` shows the confirmation. */
export function linkOpener(ask: (url: string, shown: string) => void): (url: string, shown?: string) => void {
	return (url, shown = "") => {
		if (!isAllowedUrl(url, APP_SCHEME)) return;
		if (url.startsWith("mailto:") || isTrustedHost(hostOf(url), window.location.host)) {
			window.open(url, "_blank", "noopener,noreferrer");
			return;
		}
		ask(url, shown);
	};
}
