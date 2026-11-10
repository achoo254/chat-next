/**
 * Props for a free-text field that is a message box, never a credential or an
 * address: browsers and password-manager extensions (iCloud Passwords, 1Password,
 * LastPass, Bitwarden) offer to fill any plain text field they cannot classify.
 */
export const NO_AUTOFILL = {
	autoComplete: "off",
	"data-1p-ignore": true,
	"data-lpignore": "true",
	"data-bwignore": "true",
	"data-form-type": "other",
} as const;
