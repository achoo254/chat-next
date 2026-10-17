// Command files uploads a sample document on /file and reports the size of
// every file it receives.
package main

import (
	"context"
	"fmt"
	"strings"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

func main() {
	run.Main(func(_ context.Context, _ *chatbot.Client, r *chatbot.Router) error {
		r.Command("file", func(ctx context.Context, c *chatbot.Context) error {
			msg := c.Message()
			_, err := c.Client.SendMediaUpload(ctx, chatbot.SendMediaUpload{
				ChatID:  msg.Chat.ID,
				TopicID: msg.TopicID,
				Kind:    chatbot.MediaKindDocument,
				File:    &chatbot.InputFile{Name: "hello.txt", Data: strings.NewReader("xin chào")},
				Text:    "Tệp mẫu",
			})
			return err
		})
		r.Message(func(ctx context.Context, c *chatbot.Context) error {
			media := c.Update.Message.Media
			if media == nil || media.FileID == "" {
				return nil
			}
			file, err := c.Client.GetFile(ctx, media.FileID)
			if err != nil {
				return err
			}
			data, err := c.Client.DownloadFile(ctx, file)
			if err != nil {
				return err
			}
			name := media.FileName
			if name == "" {
				name = media.Kind
			}
			_, err = c.Reply(ctx, fmt.Sprintf("Nhận %s: %d byte", name, len(data)), nil)
			return err
		})
		return nil
	})
}
