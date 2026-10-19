---
phase: 4
title: "Phase 4: Media pipeline"
status: pending
priority: P1
effort: "L"
dependencies: [2, 6, 13]
principles: [2, 4, 5, 7]
---

# Phase 4: Media pipeline

<!-- Updated: Red Team 2026-10-13 - file_id gắn chủ thể, strip EXIF đồng bộ, thumb do client sinh, CDN xác thực ở edge + purge, domain media riêng, worker sandbox, lifecycle GC -->
<!-- Updated: Validation Session 2 2026-10-14 - media domain dùng chung mọi tenant, token mang tenant_id -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - tự làm mới URL media hết hạn, upload song song thích ứng -->
<!-- Updated: Validation Session 8 2026-10-14 - user dời Media xuống cuối lộ trình; nhận thêm hiển thị media trên web, file trong Bot API, S3/CDN và chọn domain media -->
<!-- Updated: Validation Session 9 2026-10-14 - media lên prod ở release R3, không còn làm sau cùng; file của Bot API trả về Phase 8 -->

## Goal

Gửi và xem ảnh, video, file, voice nhanh như Telegram: upload tiếp tục được khi rớt mạng, thumbnail nhỏ hiện ngay, không nhảy layout, xem video bằng HTTP Range qua CDN — và không lộ media hay vị trí ngoài ý muốn.

## Thứ tự

Phase này lên prod ở release R3 (xem "Lộ trình phát hành" trong `plan.md`), ngay sau R1 (nhắn tin chữ) và R2 (webhook). Ở R1–R2 app chỉ có tin chữ: composer chưa có nút đính kèm. Contract proto media (`media.proto`, `MediaRef` trong `Message`) đã có từ Phase 1 nên thêm vào sau không phá contract.

Phase này gồm cả các phần media nằm ở phase khác:
- Hiển thị media trên web (inline thumb, kích thước cố định, trình xem ảnh) từ Phase 6.
- Dựng S3-compatible và CDN từ Phase 13 (giai đoạn 1: S3 ngoài máy `.65`).
- Chọn và đăng ký domain đăng ký riêng cho media (khác domain Mini App và mọi domain tenant; Jev 0.65 chọn hai domain riêng), cập nhật `sharedDomains.media` trong `brand.config.json`.
- Mock để duyệt: [`mockups/media.html`](./mockups/media.html).

## Context Links

- [Kỹ thuật tốc độ client web](../reports/researcher-261013-1120-telegram-web-client-speed.md) — media, stripped thumb
- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md) — media storage

## Key Insights

- Client sinh inline thumb (vài trăm byte) và đo width/height trước khi upload, nên tin có media gửi đi ngay với đủ thông tin hiển thị; server validate lại khi finalize.
- Strip EXIF/GPS **đồng bộ** trong `CompleteUpload` (libvips nhanh với ảnh); bản gốc chưa strip không bao giờ được phục vụ.
- `file_id` gắn với chủ thể sở hữu và chat nguồn; dùng lại `file_id` chỉ hợp lệ nếu người gửi là chủ hoặc xem được một tin chứa file đó.
- Media qua HTTP Range trên S3-compatible + CDN; không dùng Service Worker streaming (vỡ trên Capacitor iOS).

## Requirements

Functional:
- Ảnh thumbnail cho xem trước link (R3): bộ lấy trang của Phase 2 tải ảnh Open Graph qua cùng lớp chặn SSRF, lưu như media thường.
- Upload resumable (multipart S3 với presigned URL), giới hạn kích thước cấu hình (mặc định 2 GB).
- `CompleteUpload`: kiểm MIME thật (magic bytes), strip metadata, validate kích thước/thumb client gửi, chống decompression bomb.
- Worker nền: các cỡ ảnh (s/m/x), poster video, waveform voice, kiểm tra thêm.
- Tải xuống qua URL có token ngắn hạn, **CDN xác thực token tại edge**; purge CDN và thu hồi khi tin bị xoá cho mọi người.
- Phục vụ từ domain riêng `{{media_domain}}` (cookieless), header `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` cho loại không phải ảnh/video/audio.
- Dedupe theo `file_hash` trong phạm vi chủ sở hữu (không bao giờ xuyên tenant).
- `{{media_domain}}` dùng chung mọi tenant (ADR 0010); token tải xuống mang `tenant_id` và chủ thể, edge từ chối token của tenant bị đình chỉ.
- Lifecycle: huỷ multipart dở dang sau 24 h, GC file không còn tham chiếu.
- Upload ghi vào object key staging ngẫu nhiên, đổi tên sang key thật khi `CompleteUpload`, để presigned URL không bao giờ lộ uuid nội bộ của file (ADR 0001).
- Client: URL tải xuống hết hạn (401/403) thì tự xin URL mới theo `(chat_id, seq)` rồi thử lại một lần, không báo lỗi cho người dùng.
- Client: upload multipart chạy nhiều part song song, số luồng tự giảm khi part chậm hoặc lỗi.

Non-functional:
- Inline thumb hiển thị ngay khi tin đến; ảnh đầy đủ p50 < 300 ms qua CDN nội địa.

## Architecture

```
client: sinh thumb + đo kích thước ──CreateUpload──> api ──> S3 multipart (presigned)
client ──CompleteUpload──> api: strip EXIF, kiểm MIME, lưu metadata ──> file sẵn sàng
media worker (pod sandbox: không credential DB, seccomp, giới hạn CPU/RAM/thời gian, chỉ mạng tới S3)
client <── CDN (xác thực token tại edge, Range) <── S3
```

## Related Code Files

Create:
- `server/internal/media/` (create/complete/abort, ACL `file_id`, signed URL, purge)
- `server/internal/mediaworker/` (govips, ffmpeg tiến trình con)
- `packages/core/src/media/` (sinh thumb, đo kích thước, upload resumable)
- `server/migrations/00xx_media.sql`

## Implementation Steps

1. Bảng `files` (uuid, owner_id, mime, size, file_hash, width, height, duration, inline_thumb, sizes), `file_refs` (file_id, owner_id, source_chat_id).
2. API create/complete/abort; resume theo danh sách part.
3. Strip metadata + kiểm MIME + validate thumb trong `CompleteUpload`.
4. ACL khi gắn `file_id` vào tin (chủ sở hữu hoặc quyền xem tin chứa file).
5. Worker sandbox cho cỡ ảnh/poster/waveform.
6. Token tải xuống + cấu hình xác thực tại edge (cấu hình CDN ở Phase 13) + purge khi xoá.
7. Client: sinh thumb, đo kích thước, upload resumable.
8. Lifecycle rule + GC.

## Todo

- [x] Schema files/file_refs (migration `0009_media`: `files`, `uploads`, `message_files`, `media_jobs`, `link_preview_photos`)
- [x] Create/complete/abort + resume
- [x] Strip EXIF đồng bộ + kiểm MIME + chống bomb
- [x] ACL `file_id`
- [x] Worker (trong process `api`, ffmpeg tuỳ chọn; xem ghi chú)
- [x] Token tải + thu hồi khi xoá tin (purge CDN: không có, dùng `s-maxage=50`)
- [x] Client thumb + upload (core; UI làm ở bước sau)
- [x] Lifecycle + GC
- [ ] UI web (composer, trình xem) theo mock
- [ ] Test thủ công tua video trên 4 engine

## Success Criteria

- Upload 500 MB ngắt mạng giữa chừng tiếp tục được.
- Ảnh có GPS sau khi gửi không còn metadata vị trí (test tự động đọc EXIF bản phục vụ).
- Dùng `file_id` của chat mình không phải thành viên để gửi → bị từ chối (test tự động).
- Xoá tin cho mọi người → URL cũ trả 403/404 sau ≤ 60 s, kể cả qua CDN.
- Video tua được trên Chrome, Safari, Android WebView, WKWebView.

## Verification

- `cd server && go test ./internal/media/... ./internal/mediaworker/... -race`
- Test thủ công tua video trên 4 engine; ghi kết quả khi chạy phase.

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| ffmpeg/libvips bị khai thác | Trung bình | Pod sandbox không credential, giới hạn tài nguyên, cập nhật bản vá |
| CDN nội địa không hỗ trợ xác thực token tại edge | Trung bình | Chọn CDN có secure link; nếu không, cache key chứa token và TTL ngắn |

## Security Considerations

- Domain media tách khỏi domain app; không render HTML/SVG inline.
- Không bao giờ phục vụ bản gốc chưa strip.

## Rollback

Module riêng; worker lỗi thì tin vẫn gửi với thumb client và bản đã strip, các cỡ khác sinh lại sau.

## Ghi chú thực hiện (2026-10-15, backend và core R3)

- Lưu trữ: Jev quyết lưu trên chính server `.65` (driver `filesystem`, `/opt/chat/media`), giữ driver S3 trong code để chuyển sau (`MEDIA_STORAGE=s3`). Upload đi qua API (part 8 MiB `PUT` tới host media), không URL S3 ký sẵn, không CORS. Tải do app stream có Range (không `X-Accel-Redirect`). Backup media ra ngoài server để sau, khi có người dùng thật.
- Host media `media-chat.hoandat.com` (Cloudflare proxied, chứng chỉ riêng), cấu hình qua `MEDIA_PUBLIC_URL`; trước R9 chuyển sang domain đăng ký riêng.
- Khác plan gốc: không có "pod sandbox" ở giai đoạn 1; ảnh được giải mã bằng thư viện Go thuần (không CGO, an toàn bộ nhớ) trong process `api` với giới hạn pixel và ngân sách bộ nhớ, ffmpeg (tuỳ chọn) chạy tiến trình con với môi trường rỗng, demuxer cố định, chỉ giao thức của input. Strip metadata không mã hoá lại (giữ Orientation); thumb inline do server tạo cho ảnh, client gửi cho video khi không có ffmpeg.
- Chi tiết giao thức: [`server/README.md`](../../../server/README.md#media-package-internalmedia); vận hành: [`docs/deployment-guide.md`](../../../docs/deployment-guide.md#media-r3).
- 2026-10-19: MP4 bỏ cả ruột hộp metadata (trước chỉ đổi tên hộp); WebM/MKV bỏ metadata bằng phần tử Void cùng độ dài; album chuyển tiếp giữ nhóm; tạm dừng/tiếp tục upload từng file. Không có ffmpeg: video giữ thumb 40 px của client, khung thay thế khi không đo được (Jev 0,87).
- Còn thiếu: ảnh cho webhook, waveform cho file âm thanh chọn từ máy.

## Next Steps

Phase 6 dùng thumb/kích thước; Phase 8 dùng `file_id` cho Bot API.
