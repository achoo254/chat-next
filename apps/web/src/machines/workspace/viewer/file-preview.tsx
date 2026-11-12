// A file of the workspace, read-only (WsFileRead): text with line numbers
// and light colouring by language (the first lines; "show all" for the
// rest), markdown rendered (or its source), a picture, or why it cannot
// show (binary, too large, a secret file). A line from a content search is
// scrolled to and marked.
import { useEffect, useRef, useState } from "react";
import { WsFileKind, type WsFileReadResult } from "@achoo254/chat-proto/remote/remote";
import { AgentText } from "../../rich/agent-text.tsx";
import { CodeText } from "../../rich/code-text.tsx";
import { languageOfPath } from "../../rich/highlight.ts";
import { isMarkdown } from "../explorer/file-icon.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import { ask, type WsLink } from "../ws-client.ts";
import { formatSize } from "./format.ts";

/** Lines drawn at first; a longer file draws the rest on "show all". */
const FIRST_LINES = 2000;

const RASTER = /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/;

/** What arrived for `path`; a picture comes with its object URL (revoked when the preview moves on). */
type Loaded = { readonly path: string; readonly file: WsFileReadResult; readonly url: string } | { readonly path: string; readonly error: unknown };

interface FilePreviewProps {
	link: WsLink;
	workspaceId: string;
	path: string;
	/** 1-based line to show; 0 for none. */
	line: number;
	errorText: (err: unknown) => string;
}

export function FilePreview({ link, workspaceId, path, line, errorText }: FilePreviewProps) {
	const p = usePanelCopy();
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => {
		let live = true;
		let url = "";
		ask(link, { case: "wsFileRead", value: { workspaceId, path } }, "wsFileReadResult").then(
			(file) => {
				if (!live) return;
				// Only the raster kinds the machine sends; anything else (SVG comes as text) is not drawn from bytes.
				if (file.kind === WsFileKind.IMAGE && RASTER.test(file.mime)) url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mime }));
				setLoaded({ path, file, url });
			},
			(error: unknown) => live && setLoaded({ path, error }),
		);
		return () => {
			live = false;
			if (url !== "") URL.revokeObjectURL(url);
		};
	}, [link, workspaceId, path]);
	if (loaded === null || loaded.path !== path) {
		return (
			<p className="ws-msg" role="status" aria-busy="true">
				{p.loading}
			</p>
		);
	}
	if ("error" in loaded) {
		return (
			<p className="ws-msg mx-error" role="alert">
				{errorText(loaded.error)}
			</p>
		);
	}
	const { file } = loaded;
	const size = formatSize(Number(file.size), p.units);
	switch (file.kind) {
		case WsFileKind.TEXT:
			return isMarkdown(path) ? <MarkdownFile text={file.text} path={path} line={line} /> : <TextLines text={file.text} path={path} line={line} />;
		case WsFileKind.IMAGE:
			return loaded.url !== "" ? (
				<div className="ws-img">
					<img src={loaded.url} alt={`${p.preview.image}: ${path}`} />
				</div>
			) : (
				<p className="ws-msg">{p.preview.binary(size)}</p>
			);
		case WsFileKind.TOO_LARGE:
			return <p className="ws-msg">{p.preview.tooLarge(size)}</p>;
		default:
			return <p className="ws-msg">{p.preview.binary(size)}</p>;
	}
}

function MarkdownFile({ text, path, line }: { text: string; path: string; line: number }) {
	const p = usePanelCopy();
	const [source, setSource] = useState(line > 0);
	return (
		<div className="ws-md">
			<div className="mx-view-switch ws-seg" role="group">
				<button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
					{p.preview.rendered}
				</button>
				<button type="button" aria-pressed={source} onClick={() => setSource(true)}>
					{p.preview.source}
				</button>
			</div>
			{source ? <TextLines text={text} path={path} line={line} /> : <AgentText text={text} streaming={false} />}
		</div>
	);
}

function TextLines({ text, path, line }: { text: string; path: string; line: number }) {
	const p = usePanelCopy();
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const [all, setAll] = useState(line > FIRST_LINES);
	const shown = all ? lines : lines.slice(0, FIRST_LINES);
	const family = languageOfPath(path);
	const target = useRef<HTMLTableRowElement>(null);
	useEffect(() => {
		target.current?.scrollIntoView?.({ block: "center" });
	}, [line]);
	return (
		<div className="ws-code">
			<div className="ws-code-body" data-scroll-x="">
				<table>
					<tbody>
						{shown.map((text, i) => (
							<tr key={i} ref={i + 1 === line ? target : undefined} className={i + 1 === line ? "hit" : undefined}>
								<td className="no" aria-hidden="true">
									{i + 1}
								</td>
								<td className="code">
									<CodeText code={text} family={family} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="ws-code-foot">
				<span>{p.preview.lines(lines.length)}</span>
				{!all && lines.length > FIRST_LINES && (
					<button type="button" className="btn btn-sm" onClick={() => setAll(true)}>
						{p.preview.showAll(lines.length)}
					</button>
				)}
			</div>
		</div>
	);
}
