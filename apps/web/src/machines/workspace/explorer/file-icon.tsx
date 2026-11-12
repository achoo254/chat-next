// A file's or folder's icon in the Explorer, by type: folders (open or
// closed), code, text and docs, data and config, pictures, links. The tone
// (workspace.css .ws-ic-*) tells the families apart at a glance.
import type { WsEntry } from "@achoo254/chat-proto/remote/remote";
import { MachineIcon } from "../../machine-icons.tsx";
import { PanelIcon, type PanelIconName } from "../panel-icons.tsx";

type Family = "code" | "text" | "data" | "image" | "file";

const FAMILIES: Readonly<Record<string, Family>> = {
	ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code", go: "code", rs: "code", py: "code", rb: "code",
	java: "code", kt: "code", swift: "code", c: "code", h: "code", cpp: "code", cs: "code", php: "code", sh: "code", zsh: "code",
	ps1: "code", vue: "code", svelte: "code", css: "code", scss: "code", html: "code", sql: "code", proto: "code", lua: "code", dart: "code",
	md: "text", markdown: "text", mdx: "text", txt: "text", rst: "text", adoc: "text", log: "text",
	json: "data", jsonc: "data", yaml: "data", yml: "data", toml: "data", xml: "data", csv: "data", ini: "data", lock: "data", env: "data",
	png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", avif: "image", svg: "image",
};

const ICONS: Readonly<Record<Family, PanelIconName>> = { code: "file-code", text: "file-text", data: "file-data", image: "photo", file: "file" };

/** The family of a file name, by its extension. */
export function fileFamily(name: string): Family {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return name === "Dockerfile" || name === "Makefile" ? "code" : "file";
	return FAMILIES[name.slice(dot + 1).toLowerCase()] ?? "file";
}

/** A markdown file (shown rendered in the preview). */
export function isMarkdown(name: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(name);
}

export function EntryIcon({ entry, open }: { entry: Pick<WsEntry, "name" | "dir" | "symlink">; open?: boolean }) {
	if (entry.dir) {
		return <span className="ws-ic ws-ic-dir">{open === true ? <PanelIcon name="folder-open" small /> : <MachineIcon name="folder" small />}</span>;
	}
	if (entry.symlink) {
		return (
			<span className="ws-ic ws-ic-link">
				<PanelIcon name="link" small />
			</span>
		);
	}
	return <FileIcon name={entry.name} />;
}

export function FileIcon({ name }: { name: string }) {
	const family = fileFamily(name);
	return (
		<span className={`ws-ic ws-ic-${family}`}>
			<PanelIcon name={ICONS[family]} small />
		</span>
	);
}
