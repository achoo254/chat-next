# Go SDK của Bot API

Package `chatbot` (module `github.com/achoo254/chat-next/sdk/go`), Go ≥ 1.24, chỉ dùng thư viện chuẩn. Kiểu và method sinh từ [`spec/bot-api/openapi.yaml`](../../spec/bot-api/openapi.yaml) vào `generated.go` (không sửa tay; sinh lại bằng `cd server && go run ./cmd/sdkgen`). Hướng dẫn API: [`docs/bot-api/README.md`](../../docs/bot-api/README.md).

## Cài

Repo là private, nên báo Go không đi qua proxy và checksum DB công khai, và cho git dùng quyền truy cập GitHub của bạn:

```sh
go env -w GOPRIVATE=github.com/achoo254/chat-next
git config --global url."git@github.com:achoo254/".insteadOf "https://github.com/achoo254/"
go get github.com/achoo254/chat-next/sdk/go@<commit>   # khi có tag: @sdk/go/vX.Y.Z
```

Trong monorepo, dùng `replace github.com/achoo254/chat-next/sdk/go => ../sdk/go` trong `go.mod` của bạn.

## Bắt đầu nhanh (long poll)

```go
package main

import (
	"context"
	"log"
	"os"
	"os/signal"

	chatbot "github.com/achoo254/chat-next/sdk/go"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	client := chatbot.NewClient(os.Getenv("BOT_TOKEN")) // WithBaseURL, WithTimeout, WithRetries, WithHTTPClient
	router := chatbot.NewRouter(client)
	router.Command("start", func(ctx context.Context, c *chatbot.Context) error {
		_, err := c.Reply(ctx, "Xin chào!", nil)
		return err
	})
	router.Message(func(ctx context.Context, c *chatbot.Context) error {
		if c.Update.Message.Text == "" {
			return nil // ảnh, file không chú thích
		}
		_, err := c.Reply(ctx, c.Update.Message.Text, nil)
		return err
	})
	if err := chatbot.Poll(ctx, client, router.Handle, nil); err != nil {
		log.Fatal(err) // 409 conflict: một poll khác đang chạy hoặc bot đang có webhook
	}
}
```

- Lỗi API là `*chatbot.APIError` (`Status`, `Code`, `Description`, `RetryAfter`); dùng `errors.As` và rẽ nhánh theo `Code`, không theo `Description`.
- Client tự thử lại `429 rate_limited` và `503 unavailable` (theo `retry_after`, mặc định 3 lần); `GET` lỗi mạng cũng được thử lại, request có body thì không.
- Router: `Command(name, fn)` (khớp `/name` và `/name@username_của_bot`; `c.Args` là phần sau lệnh), `Callback(prefix, fn)` (prefix dài nhất thắng), `InlineQuery(fn)`, `Message(fn)`, `On(kind, fn)`. Trong handler: `c.Reply`, `c.Answer`, `c.AnswerInline`, hoặc gọi thẳng `c.Client`.
- Tải file lên: `client.SendMediaUpload(ctx, chatbot.SendMediaUpload{ChatID: id, Kind: chatbot.MediaKindDocument, File: &chatbot.InputFile{Name: "a.txt", Data: r}})`; album: `SendAlbumUpload(ctx, req, files)` với `req.Items` từ `chatbot.AlbumItems(...)`, mỗi `Attach` là một khoá của `files`. Tải về: `GetFile` rồi `DownloadFile`.

## Webhook

```go
handler := chatbot.WebhookHandler(os.Getenv("WEBHOOK_SECRET"), router.Handle)
http.Handle("/hook", handler)
err := client.SetWebhook(ctx, chatbot.SetWebhookRequest{URL: "https://bot.example.com/hook", Secret: os.Getenv("WEBHOOK_SECRET")})
```

Handler kiểm chữ ký trước khi đọc JSON (`401` khi sai), từ chối body > 1 MiB (`413`), trả `200` không chạy lại với `update_id` đã xử lý gần đây (1000 id), `204` khi xong, `200` + JSON khi handler trả `*WebhookAnswer`, `500` khi handler lỗi (server giao lại). Tự kiểm request trong server riêng: `chatbot.VerifyWebhook(r.Header, body, secret, time.Now())`.

## Bot mẫu

`examples/echo`, `keyboard`, `files`, `commands`, `inline` (hành vi trong [hợp đồng SDK](../../plans/dattqh/261013-0448-chat-platform-v1/phase-15-sdk-contract.md)). Biến môi trường: `BOT_TOKEN`, `BOT_API`, `BOT_MODE` (`poll` mặc định, hoặc `webhook` với `WEBHOOK_PORT`, `WEBHOOK_SECRET`, `WEBHOOK_URL`). Bot in một dòng `ready` khi sẵn sàng.

```sh
cd sdk/go
BOT_TOKEN=... BOT_API=https://chat.hoandat.com/bot/v1 go run ./examples/echo
```

## Chạy test

```sh
cd sdk/go
go vet ./... && go test -race -p 2 ./...
golangci-lint run ./...
```
