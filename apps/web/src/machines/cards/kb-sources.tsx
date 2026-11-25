// The Knowledge Base documents a kb tool answered with (kb_search,
// kb_get_document, kb_recent), as small source chips under its tool row,
// each opening the document in a new tab. Only https links of the Knowledge
// Base's own host count; any other shape or link shows nothing.
import { brand } from "../../brand.ts";

export interface KbSource {
	readonly title: string;
	readonly url: string;
}

/** The tools whose answers name documents, under any client prefix ("mcp__tunelo__kb_search"). */
const KB_TOOLS = ["kb_search", "kb_get_document", "kb_recent"];

/** Sources shown under one tool row at most. */
const MAX_SOURCES = 8;

export function isKbDocumentsTool(name: string): boolean {
	return KB_TOOLS.some((tool) => name === tool || name.endsWith(`__${tool}`));
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parse(text: string): Record<string, unknown> | null {
	try {
		return record(JSON.parse(text));
	} catch {
		return null;
	}
}

/** The documents an answer object lists (`results[]`, `documents[]` or one `document`). */
function documentsOf(answer: Record<string, unknown>): unknown[] {
	const list = Array.isArray(answer.results) ? answer.results : Array.isArray(answer.documents) ? answer.documents : [];
	return answer.document !== undefined ? [answer.document, ...list] : list;
}

/** The answer object, bare or inside an MCP result (structuredContent, or a text content holding it). */
function answersOf(output: string): Record<string, unknown>[] {
	const top = parse(output);
	if (top === null) return [];
	const found = [top];
	const structured = record(top.structuredContent);
	if (structured !== null) found.push(structured);
	if (Array.isArray(top.content)) {
		for (const part of top.content) {
			const item = record(part);
			const inner = item !== null && typeof item.text === "string" ? parse(item.text) : null;
			if (inner !== null) found.push(inner);
		}
	}
	return found;
}

/** A link of the Knowledge Base itself (https, its host); null for any other. */
function kbLink(url: string, origin: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.origin === origin ? parsed.href : null;
	} catch {
		return null;
	}
}

/** The documents of a kb tool's output with a Knowledge Base link, once each; none for any other output. */
export function kbSources(output: string, origin = brand.kbOrigin): KbSource[] {
	const seen = new Set<string>();
	const sources: KbSource[] = [];
	for (const answer of answersOf(output)) {
		for (const entry of documentsOf(answer)) {
			const doc = record(entry);
			const url = doc !== null && typeof doc.url === "string" ? kbLink(doc.url, origin) : null;
			if (doc === null || url === null || seen.has(url)) continue;
			seen.add(url);
			const title = typeof doc.title === "string" && doc.title.trim() !== "" ? doc.title.trim() : url;
			sources.push({ title, url });
		}
	}
	return sources.slice(0, MAX_SOURCES);
}

export function KbSourceChips({ sources, label }: { sources: readonly KbSource[]; label: string }) {
	if (sources.length === 0) return null;
	return (
		<ul className="mx-kb-sources" aria-label={label}>
			{sources.map((s) => (
				<li key={s.url}>
					<a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
						<span aria-hidden="true">📄</span> {s.title}
					</a>
				</li>
			))}
		</ul>
	);
}
