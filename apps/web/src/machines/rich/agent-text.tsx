// The AI's answer text. The markdown renderer (and its parser) loads on
// first use in its own chunk; meanwhile, and if it fails to load, the text
// shows as it came.
import { Component, lazy, Suspense, type ReactNode } from "react";

const Markdown = lazy(() => import("./markdown.tsx"));

class PlainOnError extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
	const plain = <div className={streaming ? "mx-agent plain streaming" : "mx-agent plain"}>{text}</div>;
	return (
		<PlainOnError fallback={plain}>
			<Suspense fallback={plain}>
				<Markdown text={text} streaming={streaming} />
			</Suspense>
		</PlainOnError>
	);
}
