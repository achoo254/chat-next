---
phase: 12
title: "Phase 12: Quyền riêng tư, an toàn và chống lạm dụng"
status: pending
priority: P1
effort: "L"
dependencies: [2, 3, 7, 8, 9]
principles: [5, 3, 7]
---

# Phase 12: Quyền riêng tư, an toàn và chống lạm dụng

<!-- Updated: Red Team 2026-10-13 - đăng ký chỉ email (bỏ số điện thoại), luật abuse cho bot/hook, công cụ cấp verified, đánh giá chuyển dữ liệu ra nước ngoài qua push, redact secret, ma trận cài đặt × API mở rộng; quyết định lưu phiên/SQLCipher/mã hoá cột đã chuyển về ADR Phase 1–2 -->
<!-- Updated: Validation Session 2 2026-10-14 - tài khoản từ hoandat-auth (bỏ OTP/CAPTCHA đăng ký), kiểm duyệt theo tenant + chủ tenant, xoá tài khoản chat vs tài khoản hoandat, redact token IdP -->
<!-- Updated: Validation Session 8 2026-10-14 - media và Mini App review ở phase của chúng -->
<!-- Updated: Validation Session 9 2026-10-14 - phần tối thiểu đi cùng R1 vì có người dùng thật; phần đầy đủ ở R9 trước khi mở công khai -->

## Goal

Biến "Privacy by design" thành tính năng cụ thể cho ứng dụng công khai hàng triệu người dùng: người dùng kiểm soát ai thấy và tìm được mình, nền tảng chặn spam/lạm dụng từ tài khoản, bot và webhook, đội vận hành có công cụ kiểm duyệt, và data model sẵn sàng cho secret chat E2E ở giai đoạn sau.

## Context Links

- [Báo cáo tổng hợp xia](../reports/xia-261013-1139-telegram-like-chat-design.md) — mô hình cloud chat + secret chat để sau
- ADR 0004, 0006, 0009, 0010 (Phase 1); `privacy_settings` mặc định và mã hoá cột email (Phase 2)

## Key Insights

- Tài khoản đến từ IdP `hoandat-auth` (chỉ Google/GitHub): không có số điện thoại, không có OTP, không có tìm bạn qua danh bạ số điện thoại. Tạo tài khoản rác tốn hơn vì cần tài khoản Google/GitHub, nhưng rủi ro tài khoản rác hàng loạt và dò tìm theo email/username vẫn còn.
- Đăng ký, cách đăng nhập và xoá tài khoản hoandat thuộc IdP. Phase này chỉ lo dữ liệu và hành vi trong app chat, trong phạm vi từng tenant.
- Cloud chat: TLS + mã hoá at-rest (volume, backup) + mã hoá cột nhạy cảm; server đọc được để search và bot. Chat `secret` đã có trong contract: không index, không bot, không đồng bộ đa thiết bị.
- Nội dung xem trước trong push đi qua hạ tầng FCM/APNs ở nước ngoài; Phase 3 mã hoá payload theo thiết bị, phase này ghi nhận đánh giá theo Nghị định 13/2023/NĐ-CP.

## Thứ tự trong lộ trình phát hành

Từ release R1 đã có người dùng thật (nhóm nội bộ), nên phần tối thiểu dưới đây đi cùng R1:
- Chặn người dùng, báo cáo tin/người, hàng đợi kiểm duyệt tối thiểu cho đội vận hành.
- Rate limit gửi tin và tạo nhóm, giới hạn tin tới người lạ.
- Cài đặt quyền riêng tư cơ bản (lần online gần nhất, ai tìm tôi bằng email, ai thêm tôi vào nhóm) và áp dụng ở mọi điểm lộ đã có.
- Logger lọc PII và secret.

Phần còn lại (chống spam đầy đủ cho bot và webhook, xuất và xoá dữ liệu, tự xoá, đánh giá Nghị định 13, xoay vòng khoá có runbook, review STRIDE) hoàn tất ở R9, trước khi mở công khai. Luật cho bot và webhook bật cùng R2 và R5.

## Requirements

Functional:
- UI và luật cài đặt riêng tư (mở rộng bảng Phase 2): last seen/online, ảnh đại diện, ai tìm được tôi bằng email, ai tìm được tôi bằng username, ai thêm tôi vào group, ai nhắn tôi, xem trước trong thông báo.
- Áp dụng ở **mọi** điểm lộ: profile, presence/typing (Phase 3), `SearchUsers`/`ResolveUsername`, Bot API lấy thông tin thành viên, webhook, search tin nhắn.
- Giới hạn dò tìm: `SearchUsers` theo email chỉ khớp chính xác, rate limit theo tài khoản và tuổi tài khoản.
- Chặn người dùng, báo cáo tin/người/bot/channel/hook, hàng đợi kiểm duyệt, công cụ vận hành: khoá tài khoản chat, gỡ nội dung, cấp/thu hồi `bots.verified`, tắt hook. Hàng đợi kiểm duyệt tách theo tenant; chủ tenant (`ownerSubs` từ API nội bộ IdP) kiểm duyệt được trong tenant của mình, đội vận hành hoandat kiểm duyệt được mọi tenant.
- Chống spam tài khoản: giới hạn số user chat mới tạo (lần đăng nhập đầu) theo IP và theo tenant, giới hạn tin tới người lạ theo tuổi tài khoản chat, giới hạn tạo group/mời, giới hạn tài khoản bị báo cáo nhiều.
- Chống abuse bot và webhook: luật theo tuổi bot, tỷ lệ bị chặn/báo cáo, đột biến số người nhận; tự hạ tầng hoặc tạm khoá; bot mới bị giới hạn bulk.
- Xoá tài khoản chat, tự huỷ sau N tháng không hoạt động (mặc định tắt, người dùng tự bật và chọn 6/12/24 tháng), xuất dữ liệu cá nhân (tải trong app, giữ 30 ngày, mỗi người yêu cầu tối đa một lần mỗi 7 ngày). Xoá tài khoản chat chỉ xoá dữ liệu chat và thu hồi grant IdP của app chat; tài khoản hoandat vẫn còn và được quản lý ở IdP. Đăng nhập lại sau khi xoá tạo user chat mới.
- Xoay vòng khoá: mã hoá cột, khoá ký OTA, khoá APNs/FCM — có runbook (khoá Mini App thêm ở Phase 16).
- Logger lọc PII **và** secret (token phiên, refresh token/ID token IdP, code OIDC, logout token, secret webhook) ở mọi role; edge redact path `/hook/*` và query của `/auth/callback`.
- Data inventory gồm: `idp_sub`, email (bản sao từ IdP), avatar, IP, refresh token IdP, khoá thiết bị, khoá Mini App, log; ghi rõ dữ liệu nào thuộc IdP (danh tính Google/GitHub) và dữ liệu nào thuộc app chat; ghi thời hạn lưu và cơ sở pháp lý; đánh giá chuyển dữ liệu ra nước ngoài qua FCM/APNs theo Nghị định 13.

Non-functional:
- Không có PII hay secret dạng rõ trong log và dump DB.

## Related Code Files

Create:
- `server/internal/{privacy,abuse,moderation}/`, `server/internal/crypto/keyrotate/`
- `server/internal/logging/redact/`
- `server/migrations/00xx_privacy_abuse.sql`
- `packages/ui/src/components/settings/privacy/`, `packages/ui/src/components/moderation/` (giao diện vận hành tối thiểu)
- `docs/privacy/{data-inventory.md,nd13-assessment.md}`
- `docs/operations/key-rotation.md`

## Implementation Steps

1. Data inventory + đánh giá Nghị định 13.
2. UI + luật cài đặt riêng tư; áp dụng ở mọi điểm lộ.
3. Giới hạn dò tìm email/username.
4. Chặn/báo cáo + hàng đợi kiểm duyệt + công cụ vận hành (verified, khoá, gỡ, tắt hook).
5. Luật chống spam tài khoản, bot, webhook.
6. Xoá/tự huỷ/xuất dữ liệu.
7. Logger redact + test quét log.
8. Xoay vòng khoá + runbook.
9. Review STRIDE cho auth (callback OIDC, back-channel logout, redirect native, cô lập tenant), Bot API, webhook (media và Mini App review ở Phase 4 và 16), OTA; chạy `/ak:security`.

## Todo

- [ ] Data inventory + đánh giá ND13
- [ ] Cài đặt riêng tư + áp dụng toàn hệ thống
- [ ] Giới hạn dò tìm
- [ ] Chặn/báo cáo/kiểm duyệt + công cụ vận hành
- [ ] Chống spam tài khoản/bot/webhook
- [ ] Xoá/tự huỷ/xuất dữ liệu
- [ ] Redact PII + secret trong log
- [ ] Xoay vòng khoá + runbook
- [ ] Review STRIDE + security scan

## Success Criteria

- Ma trận test "cài đặt × API" tự động: đặt "không ai thấy last seen" / "không ai tìm tôi bằng email" thì không API nào (client, Bot API, presence, search) lộ.
- Tài khoản mới nhắn 200 người lạ bị chặn trước tin thứ 50 (ngưỡng cấu hình); bot bị nhiều người chặn tự bị hạ tầng.
- Không tìm thấy email, token phiên, token hay code của IdP, secret webhook dạng rõ trong log và dump DB.
- Ma trận test tenant: không API nào (client, Bot API, webhook, search, presence) trả dữ liệu của tenant khác.
- Không còn finding bảo mật mức high/critical sau review.

## Verification

- `cd server && go test ./internal/privacy/... ./internal/abuse/... ./internal/moderation/... ./internal/logging/... -race`
- `/ak:security` trên toàn repo trước khi đóng phase.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Rò thông tin qua một API bị quên | Cao | Ma trận cài đặt × API trong CI |
| Chống spam chặn nhầm | Trung bình | Ngưỡng cấu hình, kháng nghị qua kiểm duyệt |

## Security Considerations

Phase này là các yêu cầu bảo mật; mọi khoá trong secret store/KMS (Phase 13), xoay vòng định kỳ.

## Rollback

Luật chống spam bật/tắt và chỉnh ngưỡng bằng cấu hình; migration có backup trước khi chạy.

## Next Steps

Secret chat E2E là plan riêng sau v1.
