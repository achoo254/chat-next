// What "Find files" found: paths by name, or matching lines grouped by file
// (line number and the line with the match marked). Each opens the file's
// preview, a line at that line.
import type { WsContentFile } from "@achoo254/chat-proto/remote/remote";
import { usePanelCopy } from "../use-panel-copy.ts";
import { FileIcon } from "./file-icon.tsx";
import { baseName, parentOf } from "./tree-model.ts";
import type { FindResult } from "./use-find.ts";

interface FindResultsProps {
	result: FindResult;
	/** The text to mark in a line (literal searches only); "" for none. */
	mark: string;
	caseSensitive: boolean;
	selected: string | null;
	onOpen: (path: string, line?: number) => void;
	errorText: (err: unknown) => string;
}

export function FindResults({ result, mark, caseSensitive, selected, onOpen, errorText }: FindResultsProps) {
	const p = usePanelCopy();
	const e = p.explorer;
	switch (result.kind) {
		case "idle":
			return null;
		case "searching":
			return (
				<p className="ws-msg" role="status" aria-busy="true">
					{e.searching}
				</p>
			);
		case "error":
			return (
				<p className="ws-msg mx-error" role="alert">
					{errorText(result.error)}
				</p>
			);
		case "names":
			return (
				<div className="ws-found" role="region" aria-label={e.findNames}>
					{result.paths.length === 0 ? (
						<p className="ws-msg">{e.noNames}</p>
					) : (
						<ul className="ws-list">
							{result.paths.map((path) => (
								<li key={path}>
									<button type="button" className={selected === path ? "ws-hit selected" : "ws-hit"} onClick={() => onOpen(path)} title={path}>
										<FileIcon name={baseName(path)} />
										<span className="ws-name">{baseName(path)}</span>
										<span className="ws-dir">{parentOf(path)}</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{result.truncated && <p className="ws-msg note">{e.namesTruncated}</p>}
				</div>
			);
		case "contents": {
			const r = result.result;
			return (
				<div className="ws-found" role="region" aria-label={e.findContents}>
					{r.files.length === 0 ? (
						<p className="ws-msg">{e.noContents}</p>
					) : (
						<>
							<p className="ws-msg note" role="status">
								{e.contentsSummary(r.totalMatches, r.files.length)}
							</p>
							<ul className="ws-list">
								{r.files.map((file) => (
									<ContentFile key={file.path} file={file} mark={mark} caseSensitive={caseSensitive} onOpen={onOpen} />
								))}
							</ul>
						</>
					)}
					{r.truncated && <p className="ws-msg note">{e.contentsTruncated}</p>}
					{r.timedOut && <p className="ws-msg note">{e.contentsTimedOut}</p>}
				</div>
			);
		}
	}
}

function ContentFile({ file, mark, caseSensitive, onOpen }: { file: WsContentFile; mark: string; caseSensitive: boolean; onOpen: (path: string, line?: number) => void }) {
	return (
		<li className="ws-cfile">
			<button type="button" className="ws-hit" onClick={() => onOpen(file.path)} title={file.path}>
				<FileIcon name={baseName(file.path)} />
				<span className="ws-name">{baseName(file.path)}</span>
				<span className="ws-dir">{parentOf(file.path)}</span>
				<span className="ws-count">{file.matches.length}</span>
			</button>
			<ul className="ws-list">
				{file.matches.map((m) => (
					<li key={`${m.line}:${m.column}`}>
						<button type="button" className="ws-hit ws-line" onClick={() => onOpen(file.path, m.line)}>
							<span className="ws-lno">{m.line}</span>
							<span className="ws-snippet">
								<Marked text={m.text.trim()} mark={mark} caseSensitive={caseSensitive} />
							</span>
						</button>
					</li>
				))}
			</ul>
		</li>
	);
}

/** `text` with each occurrence of `mark` in a <mark>. */
export function Marked({ text, mark, caseSensitive }: { text: string; mark: string; caseSensitive: boolean }) {
	if (mark === "") return <>{text}</>;
	const hay = caseSensitive ? text : text.toLowerCase();
	const needle = caseSensitive ? mark : mark.toLowerCase();
	const parts: (string | { hit: string; at: number })[] = [];
	let from = 0;
	for (let at = hay.indexOf(needle); at >= 0 && needle !== ""; at = hay.indexOf(needle, at + needle.length)) {
		if (at > from) parts.push(text.slice(from, at));
		parts.push({ hit: text.slice(at, at + needle.length), at });
		from = at + needle.length;
	}
	if (from < text.length) parts.push(text.slice(from));
	return <>{parts.map((part) => (typeof part === "string" ? part : <mark key={part.at}>{part.hit}</mark>))}</>;
}
