import type { ReactNode } from "react";

/**
 * Web sign-out is a plain form POST: the server ends the chat session and
 * redirects to the IdP end-session page, so no token ever reaches JavaScript.
 */
export function SignOutForm({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<form method="post" action="/auth/logout">
			<button type="submit" className={className}>
				{children}
			</button>
		</form>
	);
}
