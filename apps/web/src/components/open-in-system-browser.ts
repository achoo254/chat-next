import { openExternal } from "@achoo254/chat-platform-web";
import { brand } from "../brand.ts";
import { IS_NATIVE } from "../server-origin.ts";

/** The native app hands other sites (the other apps, the IdP) to the system browser, never its WebView. */
function openInSystemBrowser(url: string): void {
	openExternal(url, brand.urlScheme);
}

/** What a shared component's `onOpen`/`onOpenExternal` gets: the system browser in the native app, the component's own new tab on the web. */
export const OPEN_EXTERNAL: ((url: string) => void) | undefined = IS_NATIVE ? openInSystemBrowser : undefined;
