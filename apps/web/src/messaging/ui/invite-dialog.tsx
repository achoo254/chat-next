// Opening an invite link (mockups/chat.html#invite-preview): the app shows
// the group first and joins only when the user confirms. A user an admin
// removed with a ban gets a refusal instead (#invite-banned); a link that no
// longer admits anyone reads as gone.
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { InvitePreview } from "../data/pending-backend.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, Modal, useDomId } from "./parts.tsx";

const GONE = new Set<Code>([Code.NotFound, Code.InvalidArgument, Code.FailedPrecondition]);

type Refusal = "gone" | "banned" | null;

function refusalOf(err: unknown): Refusal {
	const code = ConnectError.from(err).code;
	if (code === Code.PermissionDenied) return "banned";
	return GONE.has(code) ? "gone" : null;
}

export function InviteDialog({ token }: { token: string }) {
	const copy = useScreensCopy();
	const { backend, remote, toasts } = useServices();
	const [preview, setPreview] = useState<InvitePreview | null | "loading">(backend.features.has("invitePreview") ? "loading" : null);
	const [refusal, setRefusal] = useState<Refusal>(null);
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
				if (found === null) setRefusal("gone");
				setPreview(found);
			},
			(err: unknown) => {
				if (!active) return;
				setRefusal(refusalOf(err));
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
				const refused = refusalOf(err);
				if (refused === null) toasts.show(copy.common.failed);
				else setRefusal(refused);
			},
		);
	};

	if (refusal === "banned") {
		return (
			<Modal labelledBy={id} onClose={close} className="narrow">
				<div className="hero">
					<span className="ban-av">
						<span className="big-icon">
							<Icon name="users" />
						</span>
						<span className="ban-badge">
							<Icon name="ban" />
						</span>
					</span>
					<h2 id={id}>{copy.invite.bannedTitle}</h2>
					<p>{copy.invite.bannedBody}</p>
				</div>
				<div className="dlg-body stack">
					<p className="note">
						<Icon name="info" />
						<span>{copy.invite.bannedNote}</span>
					</p>
				</div>
				<div className="hero-actions">
					<button type="button" className="btn" onClick={close}>
						{copy.common.close}
					</button>
				</div>
			</Modal>
		);
	}

	if (refusal === "gone") {
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
						{known.members.length > 0 && (
							<div className="av-stack" role="img" aria-label={`${copy.invite.someMembers}: ${known.members.map((member) => member.name).join(", ")}`}>
								{known.members.slice(0, 5).map((member) => (
									<ChatAvatar key={member.id} id={member.id} name={member.name} size="sm" bot={member.isBot} />
								))}
								{known.memberCount > known.members.length && (
									<span className="more">{copy.invite.more(known.memberCount - Math.min(5, known.members.length))}</span>
								)}
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
