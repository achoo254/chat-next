// Command keyboard offers two inline buttons and reports the one pressed.
package main

import (
	"context"
	"strings"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

func main() {
	run.Main(func(_ context.Context, _ *chatbot.Client, r *chatbot.Router) error {
		r.Command("start", func(ctx context.Context, c *chatbot.Context) error {
			_, err := c.Reply(ctx, "Chọn một:", &chatbot.SendMessageRequest{
				ReplyMarkup: &chatbot.ReplyMarkup{InlineKeyboard: [][]chatbot.InlineButton{{
					{Text: "A", CallbackData: "pick:a"},
					{Text: "B", CallbackData: "pick:b"},
				}}},
			})
			return err
		})
		r.Callback("pick:", func(ctx context.Context, c *chatbot.Context) error {
			choice := strings.ToUpper(strings.TrimPrefix(c.Update.Callback.Data, "pick:"))
			if choice != "A" && choice != "B" {
				return c.Answer(ctx, "", false)
			}
			if err := c.Answer(ctx, "Đã chọn "+choice, false); err != nil {
				return err
			}
			msg := c.Update.Callback.Message
			if _, err := c.Client.EditMessage(ctx, chatbot.EditMessageRequest{
				ChatID: msg.Chat.ID, Seq: msg.Seq, Text: "Bạn chọn " + choice,
			}); err != nil {
				return err
			}
			// Without reply_markup, editMarkup removes the keyboard.
			_, err := c.Client.EditMessageMarkup(ctx, chatbot.EditMarkupRequest{ChatID: msg.Chat.ID, Seq: msg.Seq})
			return err
		})
		return nil
	})
}
