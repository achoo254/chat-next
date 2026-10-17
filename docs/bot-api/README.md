# Bot API: bắt đầu nhanh

Bot gọi `https://chat.<domain>/bot/v1/…` (ví dụ `https://chat.hoandat.com/bot/v1`) bằng JSON. API là của riêng sản phẩm, không tương thích Telegram. Đặc tả đầy đủ: [`spec/bot-api/openapi.yaml`](../../spec/bot-api/openapi.yaml); định dạng chữ (`parse_mode`): [`spec/bot-api/format.md`](../../spec/bot-api/format.md).

## 1. Tạo bot và lấy token

1. Mở **Cài đặt → Developer Console → Tạo bot**. Username kết thúc bằng `bot`.
2. Ở tab **Token**, bấm **Cấp token**. Lần đầu (và mỗi lần cấp lại) cần đăng nhập lại trong 10 phút gần đây.
3. Token có dạng `<bot_id>:<secret>` và chỉ hiện một lần. Lưu vào secret manager; server chỉ giữ hash.

```sh
export BOT_TOKEN='123456:...'
export API=https://chat.hoandat.com/bot/v1
curl -s -H "Authorization: Bearer $BOT_TOKEN" $API/me
```

## 2. Nhận update bằng long poll

Mỗi request chờ tối đa 50 giây. Gửi `offset` = `update_id` cuối + 1 để xác nhận các update đã xử lý. Hai request cùng lúc thì request trước nhận `409`.

```sh
offset=0
while true; do
  r=$(curl -s -H "Authorization: Bearer $BOT_TOKEN" "$API/updates?offset=$offset&timeout=50")
  echo "$r"
  last=$(echo "$r" | jq '.result[-1].update_id // empty')
  [ -n "$last" ] && offset=$((last + 1))
done
```

Bot chỉ nhắn được người đã bấm **Bắt đầu** với bot (hoặc nhóm có bot là thành viên):

```sh
curl -s -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"chat_id": 42, "text": "Xin chào *bạn*", "parse_mode": "markdown"}' $API/messages
```

## 3. Nhận update qua webhook

Đặt webhook bằng API (hoặc tab **Nhận update** trong Developer Console; ở Console, đặt hay đổi webhook cần đăng nhập lại nếu lần đăng nhập gần nhất đã quá 10 phút, và đổi URL thì phải kèm secret mới):

```sh
curl -s -X PUT -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url": "https://bot.example.com/hook", "secret": "doi_secret_nay", "max_connections": 40}' $API/webhook
curl -s -H "Authorization: Bearer $BOT_TOKEN" $API/webhook          # trạng thái
curl -s -X DELETE -H "Authorization: Bearer $BOT_TOKEN" $API/webhook  # về long poll
```

- URL phải là `https`, cổng 443, 80 hoặc 8443, trỏ tới địa chỉ công khai (địa chỉ nội bộ bị từ chối). Không theo redirect.
- Khi webhook đang đặt, `GET /updates` trả `409`.
- Mỗi update là một `POST` JSON, giống một phần tử của `GET /updates`. Trả 2xx trong 10 giây là thành công.
- Tuần tự trong từng chat, song song giữa các chat tới `max_connections`.
- Lỗi thì thử lại sau 1 giây, nhân đôi tới trần 60–120 giây, hoặc theo `Retry-After` (ít nhất 1 giây, tối đa 1 giờ). Sau 10 lần, update vào dead-letter (xem và thử lại ở tab **Update lỗi**), các update sau của chat vẫn được giao.
- Có thể giao hơn một lần (mất câu trả lời, server khởi động lại): bỏ trùng theo `update_id`.

### Kiểm request

Mỗi request có ba header:

| Header | Giá trị |
|---|---|
| `X-Bot-Api-Secret-Token` | Secret bạn đặt |
| `X-Bot-Timestamp` | Giây Unix lúc ký |
| `X-Bot-Signature` | `v1=` + hex(HMAC-SHA256(khoá = secret, nội dung = timestamp + `.` + body gốc)) |

So sánh secret và chữ ký bằng hàm hằng thời gian (không dùng `===`/`==`) và bỏ request có timestamp lệch quá 5 phút. Vector thử: secret `my_secret`, timestamp `1760500000`, body `{"update_id":1}` cho `v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1`.

Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// Constant time for equal lengths; the length itself is not secret.
function same(got, want) {
  const a = Buffer.from(String(got ?? ""));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verify(secret, headers, rawBody) {
  const ts = String(headers["x-bot-timestamp"] ?? "");
  const want = "v1=" + createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest("hex");
  const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && same(headers["x-bot-api-secret-token"], secret) && same(headers["x-bot-signature"], want);
}
```

Python:

```python
import hashlib, hmac, time

def verify(secret: str, headers, raw_body: bytes) -> bool:
    ts = headers.get("X-Bot-Timestamp", "")
    if not (ts.isascii() and ts.isdigit()) or abs(time.time() - int(ts)) >= 300:
        return False
    want = "v1=" + hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    # Bytes: compare_digest refuses non-ASCII str instead of answering False.
    return (hmac.compare_digest(headers.get("X-Bot-Api-Secret-Token", "").encode(), secret.encode())
            and hmac.compare_digest(headers.get("X-Bot-Signature", "").encode(), want.encode()))
```

Go:

```go
func verify(secret string, r *http.Request, body []byte) bool {
	ts := r.Header.Get("X-Bot-Timestamp")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	want := "v1=" + hex.EncodeToString(mac.Sum(nil))
	n, err := strconv.ParseInt(ts, 10, 64)
	fresh := err == nil && math.Abs(float64(time.Now().Unix()-n)) < 300
	return fresh &&
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Bot-Api-Secret-Token")), []byte(secret)) == 1 &&
		hmac.Equal([]byte(r.Header.Get("X-Bot-Signature")), []byte(want))
}
```

### Trả lời ngay trong response

Body của câu trả lời 2xx có thể mang một phương thức để server chạy thay bot, ngay sau khi giao (không cần gọi API riêng):

```json
{"method": "sendMessage", "chat_id": 42, "text": "Đã nhận"}
```

Chỉ hỗ trợ `sendMessage` và `answerCallback` (`callback_id`, `text`, `show_alert`, `url`). Body tối đa 64 KiB; lớn hơn thì update vẫn tính là đã giao nhưng phương thức bị bỏ qua. Kết quả không được báo lại; lỗi bị bỏ qua. `random_id` của tin được server tự đặt theo bot và update, nên update giao lại không làm bot gửi trùng.

## 4. Sửa, xoá, chuyển tiếp tin

Các method về tin đều là `POST` JSON. Bot làm được đúng những gì một người cùng quyền làm được trong app. Trong ví dụ, `curl -s ...` là `curl -s` kèm hai header `Authorization` và `Content-Type: application/json` như ví dụ đầu.

```sh
# Sửa chữ (và thay bàn phím inline; không gửi reply_markup thì giữ bàn phím cũ)
curl -s -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"chat_id": 42, "seq": 17, "text": "*Xong* rồi", "parse_mode": "markdown",
       "reply_markup": {"inline_keyboard": [[{"text": "Xem", "url": "https://hoandat.com"}]]}}' $API/messages:edit
# Chỉ đổi bàn phím inline (không gửi reply_markup thì gỡ bàn phím; không hiện "đã sửa")
curl -s ... -d '{"chat_id": 42, "seq": 17}' $API/messages:editMarkup
```

- `messages:edit`: chỉ tin của chính bot, sửa lúc nào cũng được khi bot còn quyền gửi trong chat. Bàn phím trả lời (`keyboard`) không sửa được, gửi tin mới.
- `messages:delete` `{"chat_id", "seqs": [..]}` (1–100 tin): tin của bot luôn xoá được; tin người khác chỉ khi bot là admin (hoặc trong chat riêng). Tin không được phép xoá thì giữ nguyên; không xoá được tin nào thì `403`.
- `messages:forward` `{"from_chat_id", "seqs", "chat_id", "random_ids"}`: chuyển tiếp kèm "Chuyển tiếp từ"; `messages:copy` `{"from_chat_id", "seq", "chat_id", "text"?}`: gửi lại nội dung không kèm nguồn, `text` thay chữ hoặc chú thích. Nguồn phải là chat bot đang ở và thấy được tin; đích theo luật gửi (consent ở chat riêng).
- `messages:react` `{"chat_id", "seq", "emoji"}`: một emoji, `""` để bỏ.
- `messages:pin` / `messages:unpin` `{"chat_id", "seq"}`: cần quyền ghim (admin; thành viên nếu nhóm cho phép; cả hai phía ở chat riêng).

Gửi tin, sửa, chuyển tiếp, sao chép, file và ghim cùng tính vào giới hạn gửi của bot (mặc định 30 tin/giây, 1 tin/giây mỗi chat, dồn được 20).

## 5. Gửi ảnh và file

Tải file lên bằng `multipart/form-data` (phần `file`, `kind` là `photo`, `video`, `audio`, `voice` hoặc `document`; `entities` nếu có là chuỗi JSON). Tối đa 50 MiB một request, ảnh tối đa 20 MiB; server kiểm nội dung đúng loại, xoá EXIF/GPS, tạo ảnh thu nhỏ và tính vào dung lượng của bot. Server không tải URL hộ bot.

```sh
curl -s -H "Authorization: Bearer $BOT_TOKEN" \
  -F chat_id=42 -F kind=photo -F text='Biểu đồ hôm nay' -F file=@chart.png $API/messages:sendMedia
# Gửi lại file đã có (file_id lấy từ media.file_id của tin)
curl -s ... -d '{"chat_id": 43, "file_id": "AbC..."}' $API/messages:sendMedia
# Album 2–10 file: items là JSON, attach trỏ tới tên phần chứa file
curl -s -H "Authorization: Bearer $BOT_TOKEN" -F chat_id=42 \
  -F items='[{"attach": "a", "kind": "photo", "text": "Trước"}, {"attach": "b", "kind": "photo"}]' \
  -F a=@before.jpg -F b=@after.jpg $API/messages:sendAlbum
```

Đọc file bot thấy được (tin của bot hoặc tin trong chat bot đang ở): `GET $API/files/<file_id>` trả `size`, `mime_type`, … và `url` tải trực tiếp (GET thường, hỗ trợ Range) dùng được khoảng một giờ; xoá tin hay bot rời chat thì URL hết hiệu lực, cần URL mới thì gọi lại.

## 6. Quản trị nhóm

```sh
curl -s -H "Authorization: Bearer $BOT_TOKEN" $API/chats/77/admins
curl -s -H "Authorization: Bearer $BOT_TOKEN" $API/chats/77/members/1001
curl -s -X POST -H "Authorization: Bearer $BOT_TOKEN" $API/chats/77/members/1001:ban      # cấm và mời ra
curl -s -X POST -H "Authorization: Bearer $BOT_TOKEN" $API/chats/77/members/1001:unban    # chỉ bỏ cấm
curl -s -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"permissions": 1}' $API/chats/77/members/1001:restrict                              # chỉ được nhắn chữ
curl -s -X PATCH -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title": "Vận hành", "about": "Trực ca 24/7"}' $API/chats/77
curl -s -X POST -H "Authorization: Bearer $BOT_TOKEN" $API/chats/77:leave
```

`status` của thành viên: `owner`, `admin`, `member`, `left`, `banned`; `permissions` là bitmask: 1 nhắn tin, 2 gửi media, 4 thêm người, 8 ghim, 16 đổi thông tin nhóm, 32 quản lý chủ đề. Cấm, bỏ cấm và giới hạn cần bot là admin; đổi tên và mô tả cần quyền đổi thông tin.

"Đang gõ": `POST $API/chats/77/actions` với `{"action": "typing"}` (hoặc `upload_photo`, `upload_video`, `upload_document`, `record_voice`, `cancel`). Thành viên thấy "đang gõ…" (hoặc "đang gửi ảnh…") trong chat và ở danh sách chat khoảng 6 giây; lặp lại khoảng 4 giây một lần khi còn làm việc. Tin bot gửi tới thì dòng này tắt ngay.

## 7. Update về thành viên và reaction

- `member_changed`: tư cách thành viên của chính bot đổi (được thêm, kể cả lúc nhóm được tạo cùng bot; bị mời ra hay tự rời; được lên hay xuống admin; bị giới hạn). Có `chat`, `from` (người làm), `member` (`status`, `permissions` của bot sau thay đổi). Nhận mặc định.
- `reaction`: người dùng thả, đổi hay bỏ reaction trên tin của bot (`seq`, `user`, `emoji`; `""` là đã bỏ). Chỉ nhận khi đăng ký: webhook đặt `allowed_updates` có `reaction`; long poll gửi `allowed_updates` một lần, server nhớ:

```sh
curl -s -H "Authorization: Bearer $BOT_TOKEN" "$API/updates?allowed_updates=message,callback,member_changed,reaction"
```

## 8. Menu lệnh trong nhóm

Đặt lệnh theo phạm vi bằng `PUT $API/commands` (`scope`: `default`, `private`, `group`, `group_admin`). Trong nhóm, nút menu lệnh ở ô soạn tin liệt kê lệnh của mọi bot trong nhóm (admin thấy danh sách `group_admin`). Nhóm có từ hai bot trở lên thì lệnh chọn từ menu được gửi dạng `/lệnh@username_bot`, nên ở chế độ riêng tư chỉ đúng bot đó nhận.

## 9. Gửi hàng loạt

Một tin cho nhiều người, mỗi người nhận trong chat riêng với bot. Chỉ người đã bắt đầu bot mới nhận; người chưa bắt đầu, đã chặn bot hay đã xoá tài khoản được bỏ qua (đếm ở `skipped`).

```sh
# Theo danh sách (tối đa 10.000 user id) hoặc mọi người đã bắt đầu bot ("all": true)
curl -s ... -d '{"all": true, "text": "*Bản mới* đã có", "parse_mode": "markdown"}' $API/messages:bulk
# → {"ok": true, "result": {"bulk_id": 12, "state": "queued", "total": 840, "sent": 0, "skipped": 0, "failed": 0, ...}}
curl -s -H "Authorization: Bearer $BOT_TOKEN" $API/bulk/12            # tiến độ
curl -s -X DELETE -H "Authorization: Bearer $BOT_TOKEN" $API/bulk/12  # dừng sau lô đang gửi; tin đã gửi giữ nguyên
```

- Server gửi nền theo nhịp của tầng bot (bot mới 2 tin/giây, mặc định 10, đã xác minh 50; các lượt của cùng một bot chia nhau nhịp này) và không gửi trùng cho ai, kể cả khi server khởi động lại.
- Số người nhận trong 24 giờ có trần theo tầng: bot mới 1.000, mặc định 10.000, đã xác minh 1.000.000, bị hạn chế 0. Vượt trần trả `429 bulk_quota`; tối đa 5 lượt chưa xong cùng lúc (`429 bulk_busy`).
- Lượt dừng sớm khi bot bị xoá (`reason: bot_deleted`) hoặc bị hạn chế (`bot_restricted`).
- Gửi hàng loạt không tính vào giới hạn gửi từng tin ở mục 4.

## 10. Chế độ inline

Người dùng gõ `@username_bot từ khoá` ở đầu ô soạn tin trong bất kỳ chat nào; bot nhận update `inline_query` và trả về kết quả, người dùng chọn một kết quả để gửi dưới tên mình kèm nhãn "qua @username_bot". Bật chế độ này trong Developer Console (tab Hồ sơ → Chế độ inline, kèm chữ gợi ý hiện trong ô soạn tin). Bot chỉ nhận từ khoá, người hỏi và loại chat (`sender`, `private`, `group`, `channel`), không thấy tin trong chat.

```sh
# update: {"update_id": 9, "inline_query": {"id": "Qx…", "from": {...}, "query": "mèo", "offset": "", "chat_type": "group"}}
curl -s ... -d '{
  "cache_time": 60,
  "results": [
    {"type": "article", "id": "a1", "title": "Mèo gõ phím", "description": "Ảnh và bài", "text": "*Mèo* gõ phím",
     "parse_mode": "markdown", "thumbnail_file_id": "FILE_ID_ANH",
     "reply_markup": {"inline_keyboard": [[{"text": "Xem", "url": "https://hoandat.com"}]]}},
    {"type": "photo", "id": "p1", "file_id": "FILE_ID_ANH", "caption": "Ảnh mèo"}
  ]}' $API/inline/Qx…:answer
```

- Trả lời trong 1 phút; người dùng chờ tối đa 10 giây, quá thì app báo bot chưa trả lời.
- Tối đa 50 kết quả. `article` gửi `text`; `photo`, `video`, `document` gửi file `file_id` của bot (file bot đã gửi hoặc thấy được) kèm `caption`. Mọi kết quả có thể kèm bàn phím inline chỉ gồm nút link (không có nút callback, vì tin là của người dùng, trong chat bot có thể không tham gia); `thumbnail_file_id` là ảnh nhỏ của bài viết.
- `cache_time` (mặc định 300 giây, tối đa 3600): câu trả lời được dùng lại cho cùng từ khoá với mọi người, trừ khi `is_personal`. `gallery: true` hiện kết quả dạng lưới.
