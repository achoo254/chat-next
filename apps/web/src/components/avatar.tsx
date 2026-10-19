/** Up to two initials from a display name: "Đức Thắng" → "ĐT". */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const first = words[0];
	if (!first) return "?";
	const last = words.length > 1 ? words[words.length - 1] : undefined;
	const letters = [first, last].map((word) => (word ? Array.from(word)[0] ?? "" : ""));
	return letters.join("").toLocaleUpperCase();
}

export function Avatar({ name, size }: { name: string; size: "sm" | "xl" }) {
	"use no memo";
	return (
		<span className={`avatar ${size} av-violet`} aria-hidden="true">
			{initials(name)}
		</span>
	);
}
