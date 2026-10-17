// Package run starts an example bot from environment variables:
//
//	BOT_TOKEN       the bot token (required)
//	BOT_API         the API base URL (default chatbot.DefaultBaseURL)
//	BOT_MODE        "poll" (default) or "webhook"
//	WEBHOOK_PORT    port to listen on (webhook mode)
//	WEBHOOK_SECRET  secret of the webhook (webhook mode)
//	WEBHOOK_URL     public URL of the webhook, set with setWebhook (webhook mode)
//
// It prints exactly one line "ready" to stdout once updates can be received;
// logs go to stderr.
package run

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	chatbot "github.com/achoo254/chat-next/sdk/go"
)

// Setup registers the bot's handlers and runs its start-up calls.
type Setup func(ctx context.Context, client *chatbot.Client, router *chatbot.Router) error

// Main runs the bot until SIGINT or SIGTERM and exits with status 1 on error.
func Main(setup Setup) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, setup)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, setup Setup) error {
	token := os.Getenv("BOT_TOKEN")
	if token == "" {
		return errors.New("BOT_TOKEN is not set")
	}
	opts := []chatbot.Option{}
	if api := os.Getenv("BOT_API"); api != "" {
		opts = append(opts, chatbot.WithBaseURL(api))
	}
	client := chatbot.NewClient(token, opts...)
	router := chatbot.NewRouter(client)
	if err := setup(ctx, client, router); err != nil {
		return fmt.Errorf("setup: %w", err)
	}
	switch mode := os.Getenv("BOT_MODE"); mode {
	case "", "poll":
		return poll(ctx, client, router)
	case "webhook":
		return webhook(ctx, client, router)
	default:
		return fmt.Errorf("BOT_MODE must be poll or webhook, not %q", mode)
	}
}

func poll(ctx context.Context, client *chatbot.Client, router *chatbot.Router) error {
	if err := client.DeleteWebhook(ctx, chatbot.DeleteWebhookParams{}); err != nil {
		return fmt.Errorf("deleteWebhook: %w", err)
	}
	fmt.Println("ready")
	return chatbot.Poll(ctx, client, router.Handle, nil)
}

func webhook(ctx context.Context, client *chatbot.Client, router *chatbot.Router) error {
	port, secret, public := os.Getenv("WEBHOOK_PORT"), os.Getenv("WEBHOOK_SECRET"), os.Getenv("WEBHOOK_URL")
	if port == "" || secret == "" || public == "" {
		return errors.New("webhook mode needs WEBHOOK_PORT, WEBHOOK_SECRET and WEBHOOK_URL")
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	srv := &http.Server{
		Handler:           chatbot.WebhookHandler(secret, router.Handle),
		ReadHeaderTimeout: 10 * time.Second,
	}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	if err := client.SetWebhook(ctx, chatbot.SetWebhookRequest{URL: public, Secret: secret}); err != nil {
		_ = srv.Close()
		return fmt.Errorf("setWebhook: %w", err)
	}
	fmt.Println("ready")

	select {
	case err := <-served:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
