// Command commands publishes its command menu and answers /start and /help.
package main

import (
	"context"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

func main() {
	run.Main(func(ctx context.Context, client *chatbot.Client, r *chatbot.Router) error {
		r.Command("start", func(ctx context.Context, c *chatbot.Context) error {
			_, err := c.Reply(ctx, "Sẵn sàng.", nil)
			return err
		})
		r.Command("help", func(ctx context.Context, c *chatbot.Context) error {
			_, err := c.Reply(ctx, "Lệnh: /start, /help", nil)
			return err
		})
		return client.SetCommands(ctx, chatbot.SetCommandsRequest{Commands: []chatbot.Command{
			{Command: "start", Description: "Bắt đầu"},
			{Command: "help", Description: "Trợ giúp"},
		}})
	})
}
