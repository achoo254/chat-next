// The terminal's hidden inputs (xterm's helper textarea, the phone's input
// method field) take keystrokes, never a credential: browsers and password
// managers must not offer to fill them (Safari's "iCloud Passwords" popup
// anchored at the cursor, 1Password, LastPass, Bitwarden, Dashlane).
export const NO_AUTOFILL: Readonly<Record<string, string>> = {
	autocomplete: "off",
	autocorrect: "off",
	autocapitalize: "off",
	spellcheck: "false",
	name: "terminal-keys",
	"data-1p-ignore": "",
	"data-lpignore": "true",
	"data-bwignore": "",
	"data-form-type": "other",
};

/** Marks an input the terminal made as not a credential field. */
export function noAutofill(element: HTMLElement): void {
	for (const [name, value] of Object.entries(NO_AUTOFILL)) element.setAttribute(name, value);
}
