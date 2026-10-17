// Command echo repeats every text message that is not a command.
package main

import (
	"context"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

func main() {
	run.Main(func(_ context.Context, _ *chatbot.Client, r *chatbot.Router) error {
		r.Command("start", func(ctx context.Context, c *chatbot.Context) error {
			_, err := c.Reply(ctx, "Xin chào! Gửi gì mình nhắc lại nấy.", nil)
			return err
		})
		r.Message(func(ctx context.Context, c *chatbot.Context) error {
			msg := c.Update.Message
			if msg.Text == "" || msg.Media != nil || isCommand(msg) {
				return nil
			}
			_, err := c.Reply(ctx, msg.Text, nil)
			return err
		})
		return nil
	})
}

// isCommand reports whether the message starts with a command (other than
// the ones registered, which the router already handled).
func isCommand(m *chatbot.Message) bool {
	for _, e := range m.Entities {
		if e.Type == chatbot.EntityTypeBotCommand && e.Offset == 0 {
			return true
		}
	}
	return false
}
