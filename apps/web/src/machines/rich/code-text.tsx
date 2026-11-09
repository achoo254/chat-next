// Highlighted code as React text: one span per highlighted piece (never HTML).
import { highlight } from "./highlight.ts";

export function CodeText({ code, family }: { code: string; family: string | null }) {
	return (
		<>
			{highlight(code, family).map((piece, i) =>
				piece.kind === "plain" ? (
					piece.text
				) : (
					<span key={i} className={`hl-${piece.kind}`}>
						{piece.text}
					</span>
				),
			)}
		</>
	);
}
