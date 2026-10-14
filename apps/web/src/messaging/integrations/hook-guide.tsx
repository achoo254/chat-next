// Connection guide for a webhook's format (mockups/integrations.html#setup-guides):
// two to three steps in the usual tool and a configuration snippet to copy,
// with {URL} standing for the URL saved when the webhook was created.
import { fold } from "@app/core";
import { CopyButton, useDomId } from "../ui/parts.tsx";
import type { Hook } from "./api.ts";
import { guideSnippet } from "./samples.ts";
import { useHooksCopy } from "./use-hooks-copy.ts";

/** A receiver name for configs: the chat title folded to ASCII, words joined by "-". */
export function chatSlug(title: string): string {
	const slug = fold(title)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug === "" ? "chat" : `chat-${slug}`;
}

export function HookGuide({ hook, chatTitle }: { hook: Hook; chatTitle: string }) {
	const t = useHooksCopy();
	const id = useDomId("guide");
	const snippet = guideSnippet(hook.format, chatSlug(chatTitle));
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{t.detail.guideTitle}</h3>
			<ol className="guide-steps">
				{t.guides[hook.format].map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<div className="field">
				<div className="snippet-head">
					<span className="fmt">{t.formats[hook.format].name}</span>
					<CopyButton text={snippet} label={t.detail.copySnippet} copiedLabel={t.detail.snippetCopied} small />
				</div>
				<pre className="snippet">{snippet}</pre>
				<span className="hint">{t.detail.guideUrl}</span>
			</div>
		</section>
	);
}
