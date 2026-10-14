// Renders the dialog the screen asked for (one at a time). Dialogs load on
// first use so the first screen does not wait for them.
import { lazy, Suspense } from "react";
import { useCell, useUi, type DialogRequest } from "./ui-context.tsx";

const create = () => import("./create-dialogs.tsx");
const details = () => import("./dialogs.tsx");
const NewChatDialog = lazy(() => create().then((m) => ({ default: m.NewChatDialog })));
const NewGroupDialog = lazy(() => create().then((m) => ({ default: m.NewGroupDialog })));
const NewChannelDialog = lazy(() => create().then((m) => ({ default: m.NewChannelDialog })));
const AddMembersDialog = lazy(() => create().then((m) => ({ default: m.AddMembersDialog })));
const ForwardDialog = lazy(() => create().then((m) => ({ default: m.ForwardDialog })));
const DeleteDialog = lazy(() => details().then((m) => ({ default: m.DeleteDialog })));
const LeaveDialog = lazy(() => details().then((m) => ({ default: m.LeaveDialog })));
const LinkDialog = lazy(() => details().then((m) => ({ default: m.LinkDialog })));
const ReportDialog = lazy(() => details().then((m) => ({ default: m.ReportDialog })));
const ProfileDialog = lazy(() => details().then((m) => ({ default: m.ProfileDialog })));
const ReadByDialog = lazy(() => details().then((m) => ({ default: m.ReadByDialog })));
const AddFailedDialog = lazy(() => create().then((m) => ({ default: m.AddFailedDialog })));

export function DialogHost() {
	const ui = useUi();
	const request = useCell(ui.dialog);
	if (request === null) return null;
	return (
		<Suspense fallback={null}>
			<Dialog request={request} close={() => ui.dialog.set(null)} />
		</Suspense>
	);
}

function Dialog({ request, close }: { request: DialogRequest; close: () => void }) {
	switch (request.kind) {
		case "newChat":
			return <NewChatDialog onClose={close} />;
		case "newGroup":
			return <NewGroupDialog onClose={close} />;
		case "newChannel":
			return <NewChannelDialog onClose={close} />;
		case "addMembers":
			return <AddMembersDialog chatId={request.chatId} onClose={close} />;
		case "forward":
			return <ForwardDialog chatId={request.chatId} seq={request.seq} onClose={close} />;
		case "delete":
			return <DeleteDialog chatId={request.chatId} seq={request.seq} mine={request.mine} onClose={close} />;
		case "leave":
			return <LeaveDialog chatId={request.chatId} onClose={close} />;
		case "link":
			return <LinkDialog url={request.url} onClose={close} />;
		case "report":
			return <ReportDialog target={request.target} name={request.name} blockUserId={request.blockUserId} onClose={close} />;
		case "profile":
			return <ProfileDialog userId={request.userId} onClose={close} />;
		case "readBy":
			return <ReadByDialog chatId={request.chatId} seq={request.seq} onClose={close} />;
		case "addFailed":
			return <AddFailedDialog chatId={request.chatId} userIds={request.userIds} onClose={close} />;
	}
}
