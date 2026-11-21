// What Chat can do to people and groups in the other app, beyond the switches of the
// feature panel: invite links of the app, adding a person, leaving and deleting a group.
// Each part shows only when the app supports it and the feature sends for the chat;
// leaving and deleting ask the name of the group again, and deleting waits and asks twice.
// Loaded with the feature panel.
import { useEffect, useState } from "react";
import type { BridgeApi, BridgeCandidate, BridgeError, BridgeInviteView, GroupDeleteToken } from "./bridge-api.ts";
import type { BridgeFeatureView } from "./bridge-features-model.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";

interface Props {
	readonly accountId: number;
	readonly conversationId: string;
	readonly chatTitle: string;
	readonly appName: string;
	readonly api: BridgeApi;
	readonly features: readonly BridgeFeatureView[];
	readonly disabled: boolean;
	readonly onChanged: () => void;
	readonly onError: (err: unknown) => BridgeError;
}

const sends = (f: BridgeFeatureView | undefined): boolean => f !== undefined && f.canSend && (f.direction === "out" || f.direction === "both");

export function BridgePeople(props: Props) {
	const { features } = props;
	const byName = (name: string) => features.find((f) => f.feature === name);
	const invites = byName("invites");
	const members = byName("members");
	const lifecycle = byName("lifecycle");
	if (invites === undefined && members?.canSend !== true && lifecycle === undefined) return null;
	return (
		<section className="br-people" data-id="bridge-people">
			{invites !== undefined && <Invites {...props} on={sends(invites)} />}
			{members !== undefined && members.canSend && <AddPeople {...props} on={sends(members)} />}
			{lifecycle !== undefined && <Danger {...props} on={sends(lifecycle)} />}
		</section>
	);
}

type Common = Props & { readonly on: boolean };

function Off({ feature }: { feature: string }) {
	const t = useBridgeCopy();
	return <p className="note">{t.people.off(t.features.name[feature] ?? feature)}</p>;
}

function Invites({ accountId, conversationId, api, disabled, on, onError }: Common) {
	const t = useBridgeCopy();
	const [list, setList] = useState<readonly BridgeInviteView[] | null>(null);
	const [title, setTitle] = useState("");
	const [note, setNote] = useState("");
	const load = () => {
		api.invites(accountId, conversationId).then(setList, (err: unknown) => {
			onError(err);
			setList([]);
		});
	};
	useEffect(load, [accountId, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
	// Links the other app makes appear on its next look: ask again for a while after a request.
	useEffect(() => {
		if (note !== t.people.invites.pending) return;
		const timer = setInterval(load, 2500);
		const stop = setTimeout(() => clearInterval(timer), 20000);
		return () => {
			clearInterval(timer);
			clearTimeout(stop);
		};
	}, [note]); // eslint-disable-line react-hooks/exhaustive-deps
	const act = (run: () => Promise<void>, done: string) => {
		run().then(
			() => {
				setNote(done);
				load();
			},
			(err: unknown) => {
				onError(err);
				setNote(t.failed);
			},
		);
	};
	return (
		<div className="br-people-part">
			<h4>{t.people.invites.title}</h4>
			<p className="note">{t.people.invites.hint}</p>
			{!on && <Off feature="invites" />}
			<ul className="br-invite-list">
				{list?.length === 0 && <li className="note">{t.people.invites.none}</li>}
				{list?.map((i) => (
					<li key={i.link} className="br-invite" data-revoked={i.revoked}>
						<span className="grow br-text">
							<b>{i.title === "" ? i.link : i.title}</b>
							<small>
								{i.link} · {t.people.invites.usage(i.usage)}
								{i.revoked ? ` · ${t.people.invites.revoked}` : ""}
							</small>
						</span>
						<button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(i.link).then(() => setNote(t.people.invites.copied))}>
							{t.people.invites.copy}
						</button>
						{!i.revoked && (
							<button type="button" className="btn btn-sm btn-quiet" disabled={disabled || !on} onClick={() => act(() => api.revokeInvite(accountId, conversationId, i.link), t.people.invites.pending)}>
								{t.people.invites.revoke}
							</button>
						)}
					</li>
				))}
			</ul>
			<form
				className="br-inline"
				onSubmit={(e) => {
					e.preventDefault();
					act(() => api.createInvite(accountId, conversationId, title.trim()), t.people.invites.pending);
					setTitle("");
				}}
			>
				<input className="input" value={title} placeholder={t.people.invites.titleLabel} aria-label={t.people.invites.titleLabel} onChange={(e) => setTitle(e.target.value)} />
				<button type="submit" className="btn btn-sm" disabled={disabled || !on}>
					{t.people.invites.create}
				</button>
			</form>
			{note !== "" && (
				<p className="note" role="status">
					{note}
				</p>
			)}
		</div>
	);
}

function AddPeople({ accountId, conversationId, api, disabled, on, onError, onChanged }: Common) {
	const t = useBridgeCopy();
	const [list, setList] = useState<readonly BridgeCandidate[] | null>(null);
	const [pick, setPick] = useState("");
	const [note, setNote] = useState("");
	const load = () => {
		api.candidates(accountId, conversationId).then(setList, (err: unknown) => {
			onError(err);
			setList([]);
		});
	};
	useEffect(load, [accountId, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<div className="br-people-part">
			<h4>{t.people.add.title}</h4>
			<p className="note">{t.people.add.hint}</p>
			{!on && <Off feature="members" />}
			{list?.length === 0 ? (
				<p className="note">{t.people.add.none}</p>
			) : (
				<form
					className="br-inline"
					onSubmit={(e) => {
						e.preventDefault();
						if (pick === "") return;
						api.addMember(accountId, conversationId, pick).then(
							() => {
								setNote(t.people.add.sent);
								setPick("");
								onChanged();
								load();
							},
							(err: unknown) => {
								onError(err);
								setNote(t.failed);
							},
						);
					}}
				>
					<select className="input" value={pick} aria-label={t.people.add.pick} onChange={(e) => setPick(e.target.value)}>
						<option value="">{t.people.add.pick}</option>
						{list?.map((c) => (
							<option key={c.participantId} value={c.participantId}>
								{c.name}
							</option>
						))}
					</select>
					<button type="submit" className="btn btn-sm" disabled={disabled || !on || pick === ""}>
						{t.people.add.button}
					</button>
				</form>
			)}
			{note !== "" && (
				<p className="note" role="status">
					{note}
				</p>
			)}
		</div>
	);
}

function Danger({ accountId, conversationId, appName, api, disabled, on, onError, onChanged }: Common) {
	const t = useBridgeCopy();
	const [name, setName] = useState("");
	const [note, setNote] = useState("");
	const [pending, setPending] = useState<GroupDeleteToken | null>(null);
	const [now, setNow] = useState(() => Date.now() / 1000);
	useEffect(() => {
		if (pending === null) return;
		const timer = setInterval(() => setNow(Date.now() / 1000), 500);
		return () => clearInterval(timer);
	}, [pending]);
	const fail = (err: unknown) => {
		const error = onError(err);
		setNote(error.kind === "confirmation_wrong" ? t.people.danger.wrongName : error.kind === "reauth" ? "" : t.failed);
		if (error.kind === "confirmation_wrong") setPending(null);
	};
	const wait = pending === null ? 0 : Math.max(0, Math.ceil(pending.usableFrom - now));
	const expired = pending !== null && now > pending.expires;
	return (
		<div className="br-people-part br-danger">
			<h4>{t.people.danger.title}</h4>
			<p className="note">{t.people.danger.hint}</p>
			{!on && <Off feature="lifecycle" />}
			<input className="input" value={name} aria-label={t.people.danger.nameLabel} placeholder={t.people.danger.nameLabel} onChange={(e) => setName(e.target.value)} />
			<div className="br-actions">
				<button
					type="button"
					className="btn btn-sm btn-danger"
					disabled={disabled || !on || name.trim() === ""}
					onClick={() =>
						void api.leaveGroup(accountId, conversationId, name).then(() => {
							setNote(t.people.danger.leaveDone);
							onChanged();
						}, fail)
					}
				>
					{t.people.danger.leave}
				</button>
				{pending === null || expired ? (
					<button
						type="button"
						className="btn btn-sm btn-danger"
						disabled={disabled || !on || name.trim() === ""}
						onClick={() => {
							setNote(expired ? t.people.danger.expired : "");
							void api.requestGroupDelete(accountId, conversationId, name).then((token) => {
								setNow(Date.now() / 1000);
								setPending(token);
								setNote("");
							}, fail);
						}}
					>
						{t.people.danger.deleteStart}
					</button>
				) : (
					<>
						<span className="note">{t.people.danger.deleteWarn(appName)}</span>
						<button
							type="button"
							className="btn btn-sm btn-danger"
							disabled={wait > 0}
							onClick={() =>
								void api.deleteGroup(accountId, conversationId, name, pending.token).then(() => {
									setPending(null);
									setNote(t.people.danger.deleteDone);
									onChanged();
								}, fail)
							}
						>
							{wait > 0 ? t.people.danger.deleteWait(wait) : t.people.danger.deleteConfirm}
						</button>
					</>
				)}
			</div>
			{note !== "" && (
				<p className="note" role="status">
					{note}
				</p>
			)}
		</div>
	);
}
