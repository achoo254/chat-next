// Who carries push notifications, written once: Settings › Quyền riêng tư and
// the public privacy page (/privacy) show the same sentence. The services
// are the push hosts the server allows (docs/privacy/data-inventory.md,
// "Chuyển dữ liệu ra nước ngoài"; docs/infrastructure-inventory.md).
import type { Locale } from "./i18n.tsx";

export const pushServicesNote: Readonly<Record<Locale, string>> = {
	vi: "Thông báo đẩy đi qua dịch vụ push của trình duyệt bạn dùng (Apple, Google, Mozilla hoặc Microsoft), là dịch vụ ở nước ngoài. Nội dung được mã hoá riêng cho trình duyệt của bạn; dịch vụ push chỉ thấy địa chỉ nhận, kích thước và thời điểm.",
	en: "Push notifications go through your browser's push service (Apple, Google, Mozilla or Microsoft), which is outside Vietnam. The content is encrypted for your browser; the push service sees only the address, size and time.",
	"zh-CN": "推送通知会经由你所用浏览器的推送服务（Apple、Google、Mozilla 或 Microsoft）发送，这些服务位于越南境外。通知内容专为你的浏览器加密；推送服务只能看到接收地址、大小和时间。",
};
