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

Đặt webhook bằng API (hoặc tab **Nhận update** trong Developer Console):

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
- Lỗi thì thử lại sau 1 giây, nhân đôi tới trần 60–120 giây, hoặc theo `Retry-After`. Sau 10 lần, update vào dead-letter (xem và thử lại ở tab **Update lỗi**), các update sau của chat vẫn được giao.
- Có thể giao hơn một lần (mất câu trả lời, server khởi động lại): bỏ trùng theo `update_id`.

### Kiểm request

Mỗi request có ba header:

| Header | Giá trị |
|---|---|
| `X-Bot-Api-Secret-Token` | Secret bạn đặt |
| `X-Bot-Timestamp` | Giây Unix lúc ký |
| `X-Bot-Signature` | `v1=` + hex(HMAC-SHA256(khoá = secret, nội dung = timestamp + `.` + body gốc)) |

So sánh chữ ký bằng hàm hằng thời gian và bỏ request có timestamp lệch quá 5 phút. Vector thử: secret `my_secret`, timestamp `1760500000`, body `{"update_id":1}` cho `v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1`.

Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, rawBody) {
  const ts = headers["x-bot-timestamp"] ?? "";
  const sig = Buffer.from(headers["x-bot-signature"] ?? "");
  const want = Buffer.from("v1=" + createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest("hex"));
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && headers["x-bot-api-secret-token"] === secret && sig.length === want.length && timingSafeEqual(sig, want);
}
```

Python:

```python
import hashlib, hmac, time

def verify(secret: str, headers, raw_body: bytes) -> bool:
    ts = headers.get("X-Bot-Timestamp", "")
    want = "v1=" + hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    fresh = ts.isdigit() and abs(time.time() - int(ts)) < 300
    return (fresh and hmac.compare_digest(headers.get("X-Bot-Api-Secret-Token", ""), secret)
            and hmac.compare_digest(headers.get("X-Bot-Signature", ""), want))
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

Chỉ hỗ trợ `sendMessage` và `answerCallback` (`callback_id`, `text`, `show_alert`, `url`). Kết quả không được báo lại; lỗi bị bỏ qua. `random_id` của tin được server tự đặt theo bot và update, nên update giao lại không làm bot gửi trùng.
