// What a signed-in start shows while the account waits for deletion
// (mockups/settings.html#export-delete, "Đăng nhập lại trong 30 ngày"):
// the erasure date, why (the user asked, or auto-delete after months
// unused: the app sends no email, so this is where it is told), and the way
// back. The server refuses everything else for such a session. Its own
// chunk with its own copy, so the startup bundle carries none of it.
import { useState } from "react";
import type { SelfUser } from "../api/adapters.ts";
import { RPC_BASE_URL } from "../api/get-self.ts";
import type { RpcFetch } from "../api/client.ts";
import { BrandLogo } from "../components/brand-loader.tsx";
import { Icon } from "../components/icon.tsx";
import { SignOutForm } from "../components/sign-out-form.tsx";
import { useI18n, type Locale } from "../i18n/i18n.tsx";

const COPY = {
	vi: {
		title: "Tài khoản chat đang chờ xoá",
		requested: (username: string, date: string) => `Bạn đã yêu cầu xoá tài khoản chat @${username}. Dữ liệu chat sẽ bị xoá hẳn vào ${date}.`,
		inactive: (username: string, date: string) =>
			`Tài khoản chat @${username} lâu không được dùng nên đã được lên lịch xoá theo cài đặt Tự xoá của bạn. Dữ liệu chat sẽ bị xoá hẳn vào ${date}.`,
		keep: "Huỷ xoá để dùng tiếp như cũ: tin nhắn, nhóm, danh bạ và bot của bạn vẫn còn.",
		cancel: "Huỷ xoá tài khoản",
		cancelling: "Đang huỷ…",
		failed: "Chưa huỷ được, thử lại sau ít phút.",
		signOut: "Đăng xuất",
	},
	en: {
		title: "Your chat account is waiting for deletion",
		requested: (username: string, date: string) => `You asked to delete the chat account @${username}. Its chat data will be erased on ${date}.`,
		inactive: (username: string, date: string) =>
			`The chat account @${username} went unused, so it was scheduled for deletion by your auto-delete setting. Its chat data will be erased on ${date}.`,
		keep: "Cancel the deletion to keep using it: your messages, groups, contacts and bots are still here.",
		cancel: "Cancel deletion",
		cancelling: "Cancelling…",
		failed: "Could not cancel; try again in a few minutes.",
		signOut: "Sign out",
	},
	"zh-CN": {
		title: "你的聊天账号正在等待删除",
		requested: (username: string, date: string) => `你已申请删除聊天账号 @${username}。其聊天数据将于 ${date} 彻底删除。`,
		inactive: (username: string, date: string) =>
			`聊天账号 @${username} 长期未使用，已根据你的“自动删除”设置安排删除。其聊天数据将于 ${date} 彻底删除。`,
		keep: "取消删除即可照常使用：你的消息、群组、联系人和机器人都还在。",
		cancel: "取消删除账号",
		cancelling: "正在取消…",
		failed: "暂时无法取消，请过几分钟再试。",
		signOut: "退出登录",
	},
} as const satisfies Record<Locale, unknown>;

function dateOf(unixSeconds: number, locale: Locale): string {
	const date = new Date(unixSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	if (locale === "vi") return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
	return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** PrivacyService.CancelAccountDeletion over the Connect JSON protocol, like GetSelf. */
async function cancelDeletion(rpcFetch: RpcFetch): Promise<void> {
	const response = await rpcFetch(`${RPC_BASE_URL}/app.v1.PrivacyService/CancelAccountDeletion`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
		body: "{}",
	});
	if (!response.ok) throw new Error(`CancelAccountDeletion: HTTP ${response.status}`);
}

interface DeletionPendingProps {
	self: SelfUser;
	rpcFetch: RpcFetch;
	/** The deletion was cancelled: start the app again. */
	onRestored: () => void;
}

export default function DeletionPending({ self, rpcFetch, onRestored }: DeletionPendingProps) {
	const { locale } = useI18n();
	const t = COPY[locale];
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const date = dateOf(self.deletion?.purgeAt ?? 0, locale);
	const cancel = () => {
		setBusy(true);
		setFailed(false);
		cancelDeletion(rpcFetch).then(onRestored, () => {
			setBusy(false);
			setFailed(true);
		});
	};
	return (
		<main className="welcome">
			<section className="welcome-card" aria-labelledby="deletion-title">
				<BrandLogo decorative />
				<h1 id="deletion-title">{t.title}</h1>
				<p>{self.deletion?.reason === "inactive" ? t.inactive(self.username, date) : t.requested(self.username, date)}</p>
				<div className="welcome-hint">
					<Icon name="info" small />
					<span>{t.keep}</span>
				</div>
				{failed && (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{t.failed}</span>
					</div>
				)}
				<div className="welcome-actions">
					<button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={cancel}>
						{busy ? t.cancelling : t.cancel}
					</button>
					<SignOutForm className="btn">{t.signOut}</SignOutForm>
				</div>
			</section>
		</main>
	);
}
