// Renders the dialog the screen asked for (one at a time). Dialogs load on
// first use so the first screen does not wait for them; which dialog shows
// for a request (dialog-switch.tsx) is fetched when the app is idle.
import { Suspense } from "react";
import { DelayedLoader } from "../../components/delayed-loader.tsx";
import { preloadable } from "../../components/preload.ts";
import { useCopy } from "../copy/use-copy.ts";
import { DialogHead, Modal, useDomId } from "./parts.tsx";
import { useCell, useUi, type DialogRequest } from "./ui-context.tsx";

const dialogCode = preloadable(() => import("./dialog-switch.tsx"));
const Dialog = dialogCode.Component;

/** Fetches the dialog switch ahead (chat-screen.tsx adds it to the idle prefetch). */
export const dialogPreload = dialogCode.preload;

export function DialogHost() {
	const ui = useUi();
	const request = useCell(ui.dialog);
	if (request === null) return null;
	const close = () => ui.dialog.set(null);
	// Until its code is in, the dialog is an open shell: it answers the click
	// at once, Esc and its close button work, and the page behind is inert.
	return (
		<Suspense fallback={<DialogShell kind={request.kind} onClose={close} />}>
			<Dialog request={request} close={close} />
		</Suspense>
	);
}

/** An open dialog with its title (when the first chunk knows it) and the shared delayed loader. */
function DialogShell({ kind, onClose }: { kind: DialogRequest["kind"]; onClose: () => void }) {
	"use no memo";
	const copy = useCopy();
	const id = useDomId("dlg-shell");
	const title = kind === "newChat" ? copy.list.newChatTitle : copy.common.loading;
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={title} onClose={onClose} />
			<DelayedLoader label={copy.common.loading} />
		</Modal>
	);
}
