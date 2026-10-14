// Opening an invite link (mockups/chat.html#invite-preview): the app shows
// the group first and joins only when the user confirms.
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { InvitePreview } from "../data/pending-backend.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, Modal, useDomId } from "./parts.tsx";

const GONE = new Set<Code>([Code.NotFound, Code.InvalidArgument, Code.FailedPrecondition, Code.PermissionDenied]);

export function InviteDialog({ token }: { token: string }) {
	const copy = useScreensCopy();
	const { backend, remote, toasts } = useServices();
	const [preview, setPreview] = useState<InvitePreview | null | "loading">(backend.features.has("invitePreview") ? "loading" : null);
	const [gone, setGone] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("invite");
	const close = () => navigate(paths.home, { replace: true });

	useEffect(() => {
		if (!backend.features.has("invitePreview")) return;
		let active = true;
		backend.invitePreview(token).then(
			(found) => {
				if (!active) return;
				if (found !== null && found.memberOfChatId !== 0) {
					navigate(paths.chat(found.memberOfChatId), { replace: true });
					return;
				}
				if (found === null) setGone(true);
				setPreview(found);
			},
			(err: unknown) => {
				if (!active) return;
				if (GONE.has(ConnectError.from(err).code)) setGone(true);
				setPreview(null);
			},
		);
		return () => {
			active = false;
		};
	}, [backend, token]);

	const join = () => {
		setBusy(true);
		remote.joinByInvite(token).then(
			(chatId) => {
				if (preview !== null && preview !== "loading") toasts.show(copy.invite.joined(preview.title));
				navigate(paths.chat(chatId), { replace: true });
			},
			(err: unknown) => {
				setBusy(false);
				if (GONE.has(ConnectError.from(err).code)) setGone(true);
				else toasts.show(copy.common.failed);
			},
		);
	};

	if (gone) {
		return (
			<Modal labelledBy={id} onClose={close} className="narrow">
				<div className="hero">
					<span className="big-icon">
						<Icon name="link" />
					</span>
					<h2 id={id}>{copy.invite.goneTitle}</h2>
					<p>{copy.invite.goneBody}</p>
				</div>
				<div className="hero-actions">
					<button type="button" className="btn" onClick={close}>
						{copy.common.close}
					</button>
				</div>
			</Modal>
		);
	}

	const known = preview !== null && preview !== "loading" ? preview : null;
	return (
		<Modal labelledBy={id} onClose={close} className="narrow">
			{known !== null ? (
				<>
					<div className="hero">
						<ChatAvatar id={0} name={known.title} size="lg" />
						<h2 id={id}>{known.title}</h2>
						<p>{known.kind === "channel" ? copy.invite.subscribers(known.memberCount) : copy.invite.members(known.memberCount)}</p>
						{known.sampleNames.length > 0 && (
							<div className="av-stack" role="img" aria-label={copy.invite.someMembers}>
								{known.sampleNames.slice(0, 3).map((name, index) => (
									<ChatAvatar key={name + index} id={index + 1} name={name} size="sm" />
								))}
								{known.memberCount > 3 && <span className="more">{copy.invite.more(known.memberCount - 3)}</span>}
							</div>
						)}
					</div>
					{known.historyShared !== null && (
						<div className="dlg-body stack">
							<p className="note">
								<Icon name="info" />
								<span>{known.historyShared ? copy.invite.note : copy.invite.noteSinceJoin}</span>
							</p>
						</div>
					)}
				</>
			) : (
				<div className="hero">
					<span className="big-icon">
						<Icon name="link" />
					</span>
					<h2 id={id}>{copy.invite.genericTitle}</h2>
					<p>{preview === "loading" ? copy.common.loading : copy.invite.genericBody}</p>
				</div>
			)}
			<div className="hero-actions">
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy || preview === "loading"} onClick={join}>
					{known?.kind === "channel" ? copy.invite.joinChannel : copy.invite.join}
				</button>
				<button type="button" className="btn" onClick={close}>
					{copy.common.cancel}
				</button>
			</div>
		</Modal>
	);
}
