// Renders the dialog the screen asked for (one at a time). Dialogs load on
// first use so the first screen does not wait for them.
import { lazy, Suspense } from "react";
import { DelayedLoader } from "../../components/delayed-loader.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { DialogHead, Modal, useDomId } from "./parts.tsx";
import { useCell, useUi, type DialogRequest } from "./ui-context.tsx";

const create = () => import("./create-dialogs.tsx");
const details = () => import("./dialogs.tsx");
const chats = () => import("./chat-dialogs.tsx");
const members = () => import("./member-dialogs.tsx");
const NewChatDialog = lazy(() => create().then((m) => ({ default: m.NewChatDialog })));
const NewGroupDialog = lazy(() => create().then((m) => ({ default: m.NewGroupDialog })));
const InviteTeamDialog = lazy(() => create().then((m) => ({ default: m.InviteTeamDialog })));
const NewChannelDialog = lazy(() => create().then((m) => ({ default: m.NewChannelDialog })));
const AddMembersDialog = lazy(() => create().then((m) => ({ default: m.AddMembersDialog })));
const ForwardDialog = lazy(() => create().then((m) => ({ default: m.ForwardDialog })));
const DeleteDialog = lazy(() => details().then((m) => ({ default: m.DeleteDialog })));
const LeaveDialog = lazy(() => chats().then((m) => ({ default: m.LeaveDialog })));
const DeleteChatDialog = lazy(() => chats().then((m) => ({ default: m.DeleteChatDialog })));
const PinDialog = lazy(() => chats().then((m) => ({ default: m.PinDialog })));
const ReactorsDialog = lazy(() => chats().then((m) => ({ default: m.ReactorsDialog })));
const LinkDialog = lazy(() => details().then((m) => ({ default: m.LinkDialog })));
const ReportDialog = lazy(() => details().then((m) => ({ default: m.ReportDialog })));
const ProfileDialog = lazy(() => details().then((m) => ({ default: m.ProfileDialog })));
const ReadByDialog = lazy(() => details().then((m) => ({ default: m.ReadByDialog })));
const AddFailedDialog = lazy(() => create().then((m) => ({ default: m.AddFailedDialog })));
const MembersDialog = lazy(() => members().then((m) => ({ default: m.MembersDialog })));
const RemoveMemberDialog = lazy(() => members().then((m) => ({ default: m.RemoveMemberDialog })));
const PinnedListDialog = lazy(() => import("./pinned-dialogs.tsx").then((m) => ({ default: m.PinnedListDialog })));
const AddContactDialog = lazy(() => import("./contact-add.tsx").then((m) => ({ default: m.AddContactDialog })));
const EditChatDialog = lazy(() => import("./edit-chat-dialog.tsx"));
const BotAlertDialog = lazy(() => import("../bots/bot-chat.tsx").then((m) => ({ default: m.BotAlertDialog })));

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

function Dialog({ request, close }: { request: DialogRequest; close: () => void }) {
	switch (request.kind) {
		case "newChat":
			return <NewChatDialog onClose={close} />;
		case "newGroup":
			return <NewGroupDialog withUserId={request.withUserId} onClose={close} />;
		case "inviteTeam":
			return <InviteTeamDialog chatId={request.chatId} onClose={close} />;
		case "newChannel":
			return <NewChannelDialog onClose={close} />;
		case "addMembers":
			return <AddMembersDialog chatId={request.chatId} onClose={close} />;
		case "forward":
			return <ForwardDialog chatId={request.chatId} seq={request.seq} seqs={request.seqs ?? [request.seq]} onClose={close} />;
		case "delete":
			return <DeleteDialog chatId={request.chatId} seq={request.seq} recall={request.recall} onClose={close} />;
		case "deleteChat":
			return <DeleteChatDialog chatId={request.chatId} onClose={close} />;
		case "pin":
			return <PinDialog chatId={request.chatId} seq={request.seq} onClose={close} />;
		case "pinnedList":
			return <PinnedListDialog chatId={request.chatId} topicId={request.topicId} onClose={close} />;
		case "reactors":
			return <ReactorsDialog chatId={request.chatId} seq={request.seq} emoji={request.emoji} onClose={close} />;
		case "leave":
			return <LeaveDialog chatId={request.chatId} onClose={close} />;
		case "link":
			return <LinkDialog url={request.url} text={request.text} fromId={request.fromId} onClose={close} />;
		case "report":
			return <ReportDialog target={request.target} name={request.name} blockUserId={request.blockUserId} onClose={close} />;
		case "profile":
			return <ProfileDialog userId={request.userId} onClose={close} />;
		case "editChat":
			return <EditChatDialog chatId={request.chatId} onClose={close} />;
		case "readBy":
			return <ReadByDialog chatId={request.chatId} seq={request.seq} onClose={close} />;
		case "addFailed":
			return (
				<AddFailedDialog
					chatId={request.chatId}
					failures={request.failures}
					addedIds={request.addedIds}
					pickedNames={request.pickedNames}
					onClose={close}
				/>
			);
		case "members":
			return <MembersDialog chatId={request.chatId} onClose={close} />;
		case "removeMember":
			return <RemoveMemberDialog chatId={request.chatId} userId={request.userId} back={request.back} onClose={close} />;
		case "addContact":
			return <AddContactDialog onClose={close} />;
		case "botAlert":
			return <BotAlertDialog botId={request.botId} text={request.text} onClose={close} />;
	}
}
