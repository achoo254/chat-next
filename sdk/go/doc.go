// Package chatbot is the Go SDK of the chat Bot API.
//
// Client calls the API (one method per operation, generated from
// spec/bot-api/openapi.yaml) and retries rate limits and temporary
// unavailability. Updates arrive by long poll (Poll) or at a webhook
// (WebhookHandler, VerifyWebhook); a Router dispatches them to command,
// button, inline query and message handlers the same way in both modes:
//
//	client := chatbot.NewClient(os.Getenv("BOT_TOKEN"))
//	router := chatbot.NewRouter(client)
//	router.Command("start", func(ctx context.Context, c *chatbot.Context) error {
//		_, err := c.Reply(ctx, "Xin chào!", nil)
//		return err
//	})
//	err := chatbot.Poll(ctx, client, router.Handle, nil)
//
// The package uses only the standard library.
package chatbot
