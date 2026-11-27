// The AI's markdown answer as plain text for a chat message («Đưa vào ô soạn
// tin»): the people it goes to (Telegram, Zalo, Chat) see no `**` or
// backticks. Emphasis and code markers go, a link reads "text (url)", code
// blocks keep their lines, lists keep their markers ("- ", "1. "), and
// paragraphs stay apart by an empty line. marked tokenizes, as for showing
// the answer (machines/rich/markdown.tsx).
import { Lexer, type Token, type Tokens } from "marked";

export function plainText(markdown: string): string {
	return blocks(Lexer.lex(markdown, { gfm: true }))
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The text a reply offers for the chat's composer: the draft it sets apart as a quote ("> …", as the chat's
 * context asks the AI to), so a summary or a note around it stays out of the message; the whole reply when it
 * quotes nothing.
 */
export function draftText(markdown: string): string {
	const quotes = Lexer.lex(markdown, { gfm: true }).filter((token): token is Tokens.Blockquote => token.type === "blockquote");
	if (quotes.length === 0) return plainText(markdown);
	return quotes
		.map((quote) => blocks(quote.tokens).join("\n"))
		.join("\n\n")
		.trim();
}

function blocks(tokens: readonly Token[]): string[] {
	return tokens.flatMap((token) => {
		const text = block(token);
		return text === null ? [] : [text];
	});
}

function block(token: Token): string | null {
	const t = token as Tokens.Generic;
	switch (t.type) {
		// A task's box ("checkbox"): the list writes it as "[x] " or "[ ] " before the item's text.
		case "space":
		case "def":
		case "checkbox":
			return null;
		case "code":
			return (token as Tokens.Code).text;
		case "heading":
			return inline((token as Tokens.Heading).tokens);
		case "paragraph":
			return inline((token as Tokens.Paragraph).tokens);
		case "blockquote":
			return blocks((token as Tokens.Blockquote).tokens).join("\n");
		case "list":
			return list(token as Tokens.List);
		case "table": {
			const table = token as Tokens.Table;
			const row = (cells: readonly Tokens.TableCell[]) => cells.map((cell) => inline(cell.tokens)).join(" | ");
			return [row(table.header), ...table.rows.map(row)].join("\n");
		}
		case "hr":
			return "———";
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens === undefined ? text.text : inline(text.tokens);
		}
		default:
			// Raw HTML and anything unknown: as typed.
			return t.raw.trim();
	}
}

function list(token: Tokens.List): string {
	const first = typeof token.start === "number" ? token.start : 1;
	return token.items
		.map((item, i) => {
			const marker = token.ordered ? `${first + i}. ` : "- ";
			const task = item.task ? (item.checked === true ? "[x] " : "[ ] ") : "";
			// Lines after the first (a nested list, a second paragraph) sit under the item's text.
			const [head = "", ...rest] = blocks(item.tokens).join("\n").split("\n");
			return [`${marker}${task}${head}`, ...rest.map((line) => (line === "" ? "" : `  ${line}`))].join("\n");
		})
		.join("\n");
}

function inline(tokens: readonly Token[] | undefined): string {
	if (tokens === undefined) return "";
	return tokens.map(span).join("");
}

function span(token: Token): string {
	const t = token as Tokens.Generic;
	switch (t.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens === undefined ? text.text : inline(text.tokens);
		}
		case "strong":
		case "em":
		case "del":
			return inline((token as Tokens.Strong).tokens);
		case "codespan":
			return (token as Tokens.Codespan).text;
		case "escape":
			return (token as Tokens.Escape).text;
		case "checkbox":
			return "";
		case "br":
			return "\n";
		case "link": {
			const link = token as Tokens.Link;
			const text = inline(link.tokens);
			const bare = link.href.replace(/^mailto:/, "");
			return text === "" || text === link.href || text === bare ? bare : `${text} (${link.href})`;
		}
		case "image": {
			const image = token as Tokens.Image;
			return image.text === "" ? image.href : `${image.text} (${image.href})`;
		}
		default:
			return t.raw;
	}
}
