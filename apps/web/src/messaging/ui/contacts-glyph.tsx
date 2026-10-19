// The "Danh bạ" icon (mockups/assets/mock.js i-contacts). The folder rail and
// the narrow list header show it on the first screen, so it lives apart from
// glyphs.tsx, which only the screens loaded later need.
export function ContactsGlyph() {
	"use no memo";
	return (
		<svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M20 6v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2zM10 16h6M4 8h3M4 12h3M4 16h3" />
			<circle cx="13" cy="11" r="2" />
		</svg>
	);
}
