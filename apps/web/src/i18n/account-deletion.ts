// What deleting the chat account does, written once: Settings › Tài khoản
// and the public deletion page (/delete-account) show the same lines.
// The server's rules: server/internal/privacy (GracePeriod and the purge).
import { brand } from "../brand.ts";

/** Days between the deletion request and the erasure (privacy.GracePeriod). */
export const DELETION_GRACE_DAYS = 30;

export const deletionTicks = {
	vi: (graceDays: number, idpHost: string): string[] => [
		"Xoá hồ sơ, username, danh bạ, người đã chặn, Cloud của tôi, cài đặt và các phiên đăng nhập; bạn rời mọi nhóm và kênh.",
		'Tin bạn đã gửi trong chat của người khác vẫn còn, người gửi hiện là "Tài khoản đã xoá".',
		`Tài khoản bị khoá ngay và xoá hẳn sau ${graceDays} ngày. Đăng nhập lại trong ${graceDays} ngày để huỷ.`,
		`Tài khoản ${brand.domain} vẫn còn và dùng bình thường ở các ứng dụng khác. Quản lý hoặc xoá nó ở ${idpHost}/account.`,
	],
	en: (graceDays: number, idpHost: string): string[] => [
		"Deletes your profile, username, contacts, blocked people, Cloud, settings and sessions; you leave every group and channel.",
		'Messages you sent in other people\'s chats stay, from "Deleted account".',
		`The account is locked at once and erased after ${graceDays} days. Sign in again within ${graceDays} days to cancel.`,
		`Your ${brand.domain} account stays and keeps working in other apps. Manage or delete it at ${idpHost}/account.`,
	],
	"zh-CN": (graceDays: number, idpHost: string): string[] => [
		"删除你的个人资料、用户名、联系人、已屏蔽的用户、我的云端、设置和所有会话；你将退出所有群组和频道。",
		"你在他人聊天中发送的消息会保留，发送者显示为“已删除的账号”。",
		`账号会立即被锁定，并在 ${graceDays} 天后彻底删除。在 ${graceDays} 天内重新登录即可取消删除。`,
		`你的 ${brand.domain} 账号仍会保留，并可在其他应用中照常使用。如需管理或删除，请前往 ${idpHost}/account。`,
	],
} as const;
