---
phase: 7
title: "Phase 7: Tìm kiếm lịch sử tin nhắn"
status: in-progress
priority: P1
effort: "L"
dependencies: [2, 5]
principles: [2, 3, 5, 7]
---

# Phase 7: Tìm kiếm lịch sử tin nhắn

<!-- Updated: Red Team 2026-10-13 - bỏ tenant token, re-check gồm visible_from_seq + ẩn/xoá, cursor + over-fetch, re-rank theo dấu ở Go, chia index theo hash chat_id, lag p99 ≤ 5 s, HA/reindex, consumer outbox có thứ tự -->
<!-- Updated: Validation Session 2 2026-10-14 - lọc thêm tenant_id trong search -->
<!-- Updated: REA Telegram Desktop 2026-10-14 - debounce gọi server, FTS local chạy mỗi phím; Telegram Desktop chỉ tìm ở server nên giữ FTS5 local -->

## Goal

Tìm tin trong một chat và trên toàn bộ chat của người dùng: p50 ≤ 100 ms, gõ không dấu vẫn ra kết quả có dấu (khớp đúng dấu xếp trước), và không bao giờ trả tin mà người dùng không còn quyền xem.

## Context Links

- [Backend sync và tìm kiếm](../reports/researcher-261013-1120-backend-sync-search.md) — mục 5 (chia index, ACL, Meilisearch bỏ dấu sẵn, SLO lag)
- ADR 0003 (outbox), 0005 (fold)

## Trạng thái R4 (2026-10-15)

Đã lên prod: commit `b83b949`, migration 0011. Bản này thay thiết kế Meilisearch bên dưới cho giai đoạn chưa có người dùng thật (Jev 1.00):
- Cột `messages.search_tsv` là tsvector của các token vifold (text, caption, tên file), có GIN index, ghi cùng transaction với gửi/sửa tin, xoá khi thu hồi.
- Không dùng `pg_trgm` vì `.65` không cài contrib. Hệ quả: mỗi từ phải khớp phần đầu một từ trong tin; từ cuối được phép gõ dở.
- ACL kiểm bằng SQL; tin khớp đúng dấu xếp trước (trong top 500), rồi tới tin mới hơn; phân trang bằng cursor.
- Interface `Searcher` giữ chỗ để đổi sang Meilisearch khi có người dùng thật.
- Đo trên 200k tin trong 3.000 chat: p50 11,8 ms, p99 16,6 ms.
- Phần dưới đây là thiết kế cho giai đoạn scale.

## Tìm chuỗi con bằng pg_trgm (2026-10-15, chưa deploy)

Người vận hành đã cài `postgresql-contrib` 16.8 trên `.65` (`pg_trgm` 1.6 có trong `pg_available_extensions`), nên bỏ giới hạn "khớp đầu từ":
- Migration 0012 (chỉ thêm): `CREATE EXTENSION IF NOT EXISTS pg_trgm`, cột `messages.search_text` (chuỗi vifold của text, caption, tên file), GIN `gin_trgm_ops`; ghi cùng transaction gửi/sửa, xoá trắng khi thu hồi, backfill như `search_tsv`. `search_tsv` giữ lại: binary R4 vẫn đọc, và truy vấn toàn từ ngắn dùng nó.
- Quy tắc (server và client như nhau): có ít nhất một từ ≥ 3 ký tự thì mọi từ là chuỗi con ("uần" ra "tuần", "truc tu" ra "trực tuần"); mọi từ < 3 ký tự thì khớp đầu từ như cũ. ACL, cursor, xếp hạng đúng dấu, bộ lọc không đổi.
- Client: bảng FTS5 `messages_trigram` (tokenizer `trigram case_sensitive 1`, migration local 8, dựng lại từ cache khi nâng cấp); highlight web theo cùng quy tắc.
- Role `chat` là chủ database nên tạo được extension trusted; thiếu quyền thì migrate lỗi 42501 và release cũ tiếp tục chạy (deployment-guide).
- Đo trên 200k tin trong 3.000 chat (16 probe, 413 lần tìm, hai lần chạy): p50 15,2 / 14,7 ms, p99 35,4 / 33,5 ms; ngân sách p50 ≤ 100 ms, p99 ≤ 500 ms.

## Key Insights

- Postgres là nguồn sự thật; index luôn dựng lại được.
- Meilisearch tự bỏ dấu ở mọi trường nên không tự xếp "khớp đúng dấu" lên trước. Giải pháp: lấy top-K từ engine rồi **re-rank ở tầng Go** bằng điểm khớp trên chuỗi gốc có dấu.
- Chia nhiều index theo hash `chat_id` ngay từ đầu; search toàn cục dùng multi-search song song rồi gộp.
- ACL: filter theo danh sách chat của người dùng (chia lô phía server khi dài), sau đó **re-check trong Postgres**: membership, `visible_from_seq`, `user_hidden_messages`, xoá cho mọi người. Không phát tenant token cho client. Document có `tenant_id` và mọi truy vấn lọc thêm theo tenant của người gọi, làm lớp phòng thủ thứ hai cho ADR 0010 (khác với "tenant token" của Meilisearch).
- Re-check loại bớt kết quả nên phân trang dùng cursor và over-fetch (lặp tới khi đủ K, có giới hạn vòng).
- Consumer outbox của indexer shard theo `chat_id` để giữ thứ tự; so `edit_version` để bỏ qua bản ghi cũ.

## Requirements

Functional:
- Topic bị admin ẩn: tin của topic vẫn nằm trong kết quả tìm kiếm của thành viên; ẩn chỉ bỏ topic khỏi danh sách topic.
- Indexer tiêu thụ outbox (`message_new`, `message_edit`, `message_delete`, `message_hidden` không cần index, `member_removed` không cần index vì ACL re-check) theo cursor riêng.
- `SearchMessages(query, filters, cursor)` toàn cục và `SearchChatMessages(chat_id, query, filters, cursor)`; lọc người gửi, loại media, khoảng ngày.
- Chat `secret` không bao giờ được index.
- Lệnh reindex toàn bộ / theo chat / theo index shard.
- Client: kết quả FTS5 local hiện ngay mỗi phím, gọi server có debounce (giá trị tự đo), gộp kết quả server, nhảy tới tin. Kết quả local thuộc vùng cache `stale` (Phase 5) được kiểm lại bằng kết quả server.

Non-functional:
- Search p50 ≤ 100 ms, p99 ≤ 500 ms (kể cả người dùng có 3.000 chat).
- Gửi → tìm được: p50 ≤ 1 s, p99 ≤ 5 s.
- Mất một node search thì search toàn cục vẫn chạy (bản sao thứ hai) hoặc trả lỗi rõ ràng trong ≤ 1 s, không treo.

## Architecture

```
outbox (cursor search, shard theo chat_id) ──> indexer ──batch──> Meilisearch index msgs_{hash(chat_id) % N}
                                                         └─────> bản sao thứ hai (dual-write) cho failover
client ──SearchMessages──> api ──> filter chat_id IN (lô) ──> multi-search các index
                                 └─ re-check Postgres ──> re-rank theo dấu ──> cursor
```

Document: `{id, chat_id, seq, from_id, date, text, media_type, edit_version}`; text gốc giữ để re-rank.

## Related Code Files

Create:
- `server/internal/search/` (engine interface, Meilisearch, indexer, query, ACL re-check, re-rank, reindex)
- `packages/core/src/search/` (gộp local + server)
- `packages/ui/src/components/search/`
- `server/testdata/vi-search-corpus.jsonl`

## Implementation Steps

1. Interface `SearchEngine` + Meilisearch; N index shard (N cấu hình, mặc định 16).
2. Indexer consumer có thứ tự, idempotent theo `(id, edit_version)`, batch 500 hoặc 200 ms.
3. Query: fold truy vấn, filter ACL theo lô, multi-search.
4. Re-check Postgres + re-rank theo dấu + cursor over-fetch.
5. Dual-write bản sao thứ hai; reindex theo shard; đo thời gian reindex 100 triệu tin.
6. Client gộp local/server.
7. Bộ đánh giá tiếng Việt: ≥ 5.000 tin, ≥ 100 truy vấn có đáp án.
8. Benchmark người dùng 3.000 chat để chốt kích thước lô filter.

## Todo

- [ ] Engine + N index shard
- [ ] Indexer có thứ tự + edit_version
- [ ] Query + ACL lô + multi-search
- [ ] Re-check + re-rank + cursor
- [ ] Dual-write + reindex
- [ ] Gộp local/server
- [ ] Bộ đánh giá tiếng Việt
- [ ] Benchmark 3.000 chat

## Success Criteria

- "nguoi dep da nang" tìm được "Người đẹp Đà Nẵng" ở server và local.
- Rời chat / bị kick / tin bị xoá cho mình → không còn trong kết quả (server và local), test tự động.
- Thành viên mới của group đặt "không xem lịch sử cũ" không tìm được tin trước khi tham gia.
- recall@10 ≥ 0,95; khớp đúng dấu xếp trên khớp không dấu ở ≥ 90% truy vấn (nhờ re-rank).
- Trang kết quả luôn đủ K mục hoặc báo hết, không trùng giữa các trang.

## Verification

- `cd server && go test ./internal/search/... -race`
- `cd server && go run ./cmd/server search-eval --corpus testdata/vi-search-corpus.jsonl`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Meilisearch CE không đủ khi index lớn | Trung bình | Chia shard từ đầu; interface để chuyển OpenSearch theo số đo Phase 14 |
| Filter ACL dài | Trung bình | Chia lô, benchmark 3.000 chat |
| Reindex lâu sau sự cố | Trung bình | Bản sao thứ hai; reindex theo shard song song |

## Security Considerations

- Không tin index cho ACL; luôn re-check Postgres.
- Meilisearch chỉ trong mạng nội bộ, bắt buộc API key, không lộ cho client.

## Rollback

Search là role riêng; tắt indexer không ảnh hưởng gửi/nhận; index xoá và dựng lại được.

## Next Steps

Phase 14 đo tải; vượt ngưỡng thì làm implementation OpenSearch của `SearchEngine`.
