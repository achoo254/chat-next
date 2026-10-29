// "Kết nối AI (MCP)": how to add the MCP endpoint (ADR 0012) to an AI tool.
// Sign-in is OAuth at the IdP, so there is no token to make or show here;
// the scopes mirror server/internal/chatmcp and grants are revoked at the IdP.
import { useState } from "react";
import { brand } from "../../brand.ts";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { serverOrigin } from "../../server-origin.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { Choice, CopyButton, copyText } from "../ui/parts.tsx";
import "./mcp-settings.css";

type McpClient = "claude" | "cursor" | "vscode";

/** The server name every snippet registers, as `chat` in `/mcp`. */
const SERVER_NAME = "chat";

/** What to run or paste in each AI tool for the endpoint at `url`. */
export function mcpSnippet(client: McpClient, url: string): string {
	switch (client) {
		case "claude":
			return `claude mcp add --transport http ${SERVER_NAME} ${url}`;
		case "cursor":
			return JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2);
		case "vscode":
			return JSON.stringify({ servers: { [SERVER_NAME]: { type: "http", url } } }, null, 2);
	}
}

export function McpSettings() {
	const copy = useScreensCopy();
	const t = copy.mcp;
	const url = `${serverOrigin()}/mcp`;
	const scopes = [
		{ scope: "chat:read", text: t.chatRead },
		{ scope: "chat:write", text: t.chatWrite },
		{ scope: "bots:read", text: t.botsRead },
		{ scope: "bots:write", text: t.botsWrite },
		{ scope: "bots:admin", text: t.botsAdmin, risky: true },
	];
	return (
		<div className="set-body mcp">
			<p className="lede">
				<Icon name="plug" small />
				{t.lede}
			</p>
			<div className="card pad" data-id="mcp-address">
				<h2 className="card-title flush">{t.address}</h2>
				<div className="mcp-address">
					<code className="mono">{url}</code>
					<CopyButton text={url} label={t.copyAddress} copiedLabel={t.copied} />
				</div>
				<p className="note">{t.signInNote}</p>
			</div>
			<McpHowTo url={url} />
			<div className="card" data-id="mcp-scopes">
				<h2 className="card-title">{t.scopes}</h2>
				{scopes.map((item) => (
					<div className="row pad-x" key={item.scope}>
						<span className="grow">
							<code className="mono">{item.scope}</code> {item.risky === true && <span className="tag warn">{t.risky}</span>}
							<small>{item.text}</small>
						</span>
					</div>
				))}
				<div className="callout pad-x">
					<Icon name="lock" small />
					<p>
						{t.scopesNote} {t.readNote}
					</p>
				</div>
			</div>
			<section className="card" data-id="mcp-revoke">
				<div className="row pad-x">
					<span className="device">
						<Icon name="shield" />
					</span>
					<span className="grow">
						{t.revoke}
						<small>{t.revokeHint}</small>
					</span>
					<ExternalLink className="btn" href={brand.accountUrl}>
						{t.manage}
					</ExternalLink>
				</div>
			</section>
		</div>
	);
}

/** The snippet of the picked AI tool, with "Sao chép". */
function McpHowTo({ url }: { url: string }) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const [client, setClient] = useState<McpClient>("claude");
	const t = copy.mcp;
	const snippet = mcpSnippet(client, url);
	const hints: Record<McpClient, string> = { claude: t.claudeHint, cursor: t.cursorHint, vscode: t.vscodeHint };
	return (
		<div className="card pad" data-id="mcp-how-to">
			<h2 className="card-title flush">{t.howTo}</h2>
			<Choice<McpClient>
				label={t.client}
				value={client}
				options={[
					{ value: "claude", label: "Claude Code" },
					{ value: "cursor", label: "Cursor" },
					{ value: "vscode", label: "VS Code" },
				]}
				onChange={setClient}
			/>
			<p className="note">{hints[client]}</p>
			<pre className="mcp-snippet" aria-label={t.howTo}>
				{snippet}
			</pre>
			<div className="mcp-snippet-actions">
				<button
					type="button"
					className="btn btn-sm"
					onClick={() => {
						void copyText(snippet).then((ok) => toasts.show(ok ? t.snippetCopied : copy.common.failed));
					}}
				>
					<Icon name="copy" small />
					{t.copySnippet}
				</button>
			</div>
			<p className="note">{t.otherHint}</p>
		</div>
	);
}
