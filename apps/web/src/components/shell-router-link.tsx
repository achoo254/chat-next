import type { ShellLinkComponent } from "@achoo254/app-shell";
import { followInApp } from "../router.tsx";

/**
 * The link the shared shell (@achoo254/app-shell) draws for Chat's own
 * paths: they open in place, without a reload. A server route such as
 * /auth/login (the header's sign-in on a page sign-in returns to) is left to
 * the browser.
 */
export const ShellRouterLink: ShellLinkComponent = ({ href, onClick, children, ...rest }) => (
	<a
		{...rest}
		href={href}
		onClick={(event) => {
			onClick?.(event);
			if (!href.startsWith("/auth/")) followInApp(event, href);
		}}
	>
		{children}
	</a>
);
