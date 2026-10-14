// Accent-insensitive highlighting for search results: "tieng viet" marks
// "Tiếng Việt". Each code point is folded on its own so positions map back
// to the original text (vifold's whole-string fold collapses whitespace).

export interface Segment {
	readonly text: string;
	readonly match: boolean;
}

function foldChar(char: string): string {
	return char
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.replaceAll("đ", "d")
		.replaceAll("Đ", "d")
		.toLowerCase();
}

/** Splits `text` into marked and plain runs for every token of `query`. */
export function highlight(text: string, query: string): Segment[] {
	const tokens = query
		.split(/\s+/)
		.map((token) => [...token].map(foldChar).join(""))
		.filter((token) => token !== "");
	if (tokens.length === 0 || text === "") return [{ text, match: false }];

	// Folded text plus, for each folded UTF-16 unit, the original index it came from.
	let folded = "";
	const origin: number[] = [];
	let index = 0;
	for (const char of text) {
		const f = foldChar(char);
		for (let i = 0; i < f.length; i++) origin.push(index);
		folded += f;
		index += char.length;
	}
	origin.push(text.length);

	const marked = new Array<boolean>(text.length).fill(false);
	for (const token of tokens) {
		let from = folded.indexOf(token);
		while (from !== -1) {
			const start = origin[from] ?? 0;
			const end = origin[from + token.length] ?? text.length;
			for (let i = start; i < end; i++) marked[i] = true;
			from = folded.indexOf(token, from + token.length);
		}
	}

	const segments: Segment[] = [];
	let start = 0;
	for (let i = 1; i <= text.length; i++) {
		if (i === text.length || marked[i] !== marked[start]) {
			segments.push({ text: text.slice(start, i), match: marked[start] === true });
			start = i;
		}
	}
	return segments;
}
