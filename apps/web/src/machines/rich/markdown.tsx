// Markdown of the AI's answers (GitHub flavour: headings, lists with tasks,
// tables, quotes, code blocks with a copy button and light highlighting,
// links). marked only tokenizes; the tokens become React elements here, so
// no HTML from the machine ever reaches the page: raw HTML shows as text,
// images show as links, and a link opens only for http(s) or mailto, in a
// new tab without an opener. Loaded on demand (agent-text.tsx).
import { Lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import { CopyButton } from "../../messaging/ui/parts.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { CodeText } from "./code-text.tsx";
import { languageOf } from "./highlight.ts";

/** The URL when it is safe to open from the AI's text; null otherwise. */
export function safeHref(href: string): string | null {
	try {
		const url = new URL(href);
		return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
	} catch {
		return null;
	}
}

export default function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
	const tokens = Lexer.lex(text, { gfm: true });
	return <div className={streaming ? "mx-agent md streaming" : "mx-agent md"}>{blocks(tokens)}</div>;
}

function blocks(tokens: readonly Token[]): ReactNode[] {
	return tokens.map((token, i) => <Block key={i} token={token} />);
}

function Block({ token }: { token: Token }): ReactNode {
	const t = token as Tokens.Generic;
	switch (t.type) {
		case "space":
		case "def":
			return null;
		case "code": {
			const code = token as Tokens.Code;
			return <CodeBlock code={code.text} lang={(code.lang ?? "").split(/\s/)[0] ?? ""} />;
		}
		case "heading": {
			const heading = token as Tokens.Heading;
			return (
				<p className={`md-h md-h${Math.min(heading.depth, 4)}`} role="heading" aria-level={Math.min(6, heading.depth + 2)}>
					{inline(heading.tokens)}
				</p>
			);
		}
		case "paragraph":
			return <p>{inline((token as Tokens.Paragraph).tokens)}</p>;
		case "blockquote":
			return <blockquote>{blocks((token as Tokens.Blockquote).tokens)}</blockquote>;
		case "list": {
			const list = token as Tokens.List;
			const items = list.items.map((item, i) => (
				<li key={i} className={item.task ? "task" : undefined}>
					{item.task && (
						<span className={item.checked ? "md-box on" : "md-box"} aria-hidden="true">
							{item.checked ? "✓" : ""}
						</span>
					)}
					{listItem(item)}
				</li>
			));
			return list.ordered ? <ol start={typeof list.start === "number" ? list.start : undefined}>{items}</ol> : <ul>{items}</ul>;
		}
		case "table":
			return <Table table={token as Tokens.Table} />;
		case "hr":
			return <hr />;
		case "text": {
			const text = token as Tokens.Text;
			return <p>{text.tokens === undefined ? text.text : inline(text.tokens)}</p>;
		}
		default:
			// Raw HTML and anything unknown: shown as typed.
			return <p>{t.raw}</p>;
	}
}

/** A tight item holds text tokens (inline); a loose one holds paragraphs. */
function listItem(item: Tokens.ListItem): ReactNode {
	return item.tokens.map((token, i) => {
		if (token.type === "checkbox") return null;
		if (token.type === "text") {
			const text = token as Tokens.Text;
			return <span key={i}>{text.tokens === undefined ? text.text : inline(text.tokens)}</span>;
		}
		return <Block key={i} token={token} />;
	});
}

function inline(tokens: readonly Token[] | undefined): ReactNode[] {
	return (tokens ?? []).map((token, i) => <Inline key={i} token={token} />);
}

function Inline({ token }: { token: Token }): ReactNode {
	const t = useMachinesCopy();
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens === undefined ? decode(text.text) : inline(text.tokens);
		}
		case "escape":
			return decode((token as Tokens.Escape).text);
		case "strong":
			return <strong>{inline((token as Tokens.Strong).tokens)}</strong>;
		case "em":
			return <em>{inline((token as Tokens.Em).tokens)}</em>;
		case "del":
			return <del>{inline((token as Tokens.Del).tokens)}</del>;
		case "codespan":
			return <code>{decode((token as Tokens.Codespan).text)}</code>;
		case "br":
			return <br />;
		case "link": {
			const link = token as Tokens.Link;
			const href = safeHref(link.href);
			if (href === null) return inline(link.tokens);
			return (
				<a href={href} target="_blank" rel="noopener noreferrer">
					{inline(link.tokens)}
					<span className="sr-only"> {t.agent.md.newTab}</span>
				</a>
			);
		}
		case "image": {
			// No remote images in the transcript: the picture's link instead.
			const image = token as Tokens.Image;
			const href = safeHref(image.href);
			const label = image.text === "" ? image.href : image.text;
			return href === null ? (
				label
			) : (
				<a href={href} target="_blank" rel="noopener noreferrer">
					{label}
				</a>
			);
		}
		default:
			// Raw HTML (an "html" token) and anything unknown: shown as typed.
			return (token as Tokens.Generic).raw;
	}
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** marked escapes a few characters in some tokens; React escapes again, so undo marked's. */
function decode(text: string): string {
	return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
	const t = useMachinesCopy();
	return (
		<div className="md-code">
			<div className="md-code-head">
				<span>{t.agent.md.code(lang)}</span>
				<CopyButton text={code} label={t.agent.md.copy} copiedLabel={t.agent.md.copied} small />
			</div>
			<pre data-scroll-x="">
				<code>
					<CodeText code={code} family={languageOf(lang)} />
				</code>
			</pre>
		</div>
	);
}

function Table({ table }: { table: Tokens.Table }) {
	const align = (i: number) => {
		const a = table.align[i];
		return a === null || a === undefined ? undefined : { textAlign: a };
	};
	return (
		<div className="md-table" data-scroll-x="">
			<table>
				<thead>
					<tr>
						{table.header.map((cell, i) => (
							<th key={i} style={align(i)}>
								{inline(cell.tokens)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{table.rows.map((row, r) => (
						<tr key={r}>
							{row.map((cell, i) => (
								<td key={i} style={align(i)}>
									{inline(cell.tokens)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
