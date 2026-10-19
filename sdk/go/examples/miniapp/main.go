// Command miniapp sends a button that opens the shop's Mini App and runs the
// Mini App's backend: POST /verify takes the raw init data and answers who
// opened it (401 when it is not genuine). Data the Mini App sends back
// arrives as web_app_data and is confirmed in the chat. Environment (besides
// package run): MINI_APP_URL (https, on your own domain), MINI_APP_PORT (port
// of the backend).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

// maxBody bounds the request: init data is a short query string.
const maxBody = 8 << 10

func main() {
	run.Main(func(ctx context.Context, client *chatbot.Client, r *chatbot.Router) error {
		appURL := envOr("MINI_APP_URL", "https://shop.example.com/app")
		port := envOr("MINI_APP_PORT", "8081")
		if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
			return errors.New("MINI_APP_PORT must be a port number")
		}
		me, err := client.GetMe(ctx)
		if err != nil {
			return fmt.Errorf("getMe: %w", err)
		}
		if err := serveBackend(ctx, port, &verifier{client: client, botID: me.ID}); err != nil {
			return err
		}

		r.Command("start", func(ctx context.Context, c *chatbot.Context) error {
			_, err := c.Reply(ctx, "Mở cửa hàng để đặt món:", &chatbot.SendMessageRequest{
				ReplyMarkup: &chatbot.ReplyMarkup{InlineKeyboard: [][]chatbot.InlineButton{{
					{Text: "Mở cửa hàng", WebApp: &chatbot.WebAppInfo{URL: appURL}},
				}}},
			})
			return err
		})
		r.Message(func(ctx context.Context, c *chatbot.Context) error {
			sent := c.Update.Message.WebAppData
			if sent == nil {
				return nil
			}
			_, err := c.Reply(ctx, "Đã nhận đơn: "+sent.Data, nil)
			return err
		})
		return nil
	})
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// verifier checks init data with the server's public key, cached; when the
// check fails the key is fetched again once, as the server may have rotated it.
type verifier struct {
	client *chatbot.Client
	botID  int64
	mu     sync.Mutex
	key    string
}

func (v *verifier) verify(ctx context.Context, initData string) (*chatbot.MiniAppInitData, error) {
	v.mu.Lock()
	key := v.key
	v.mu.Unlock()
	if key != "" {
		if data, err := chatbot.VerifyMiniAppInitData(initData, v.botID, key, 0, time.Now()); err == nil {
			return data, nil
		}
	}
	fresh, err := v.client.GetMiniAppKey(ctx)
	if err != nil {
		return nil, fmt.Errorf("getMiniAppKey: %w", err)
	}
	v.mu.Lock()
	v.key = fresh.PublicKey
	v.mu.Unlock()
	return chatbot.VerifyMiniAppInitData(initData, v.botID, fresh.PublicKey, 0, time.Now())
}

// serveBackend listens on port and serves POST /verify until ctx ends.
func serveBackend(ctx context.Context, port string, v *verifier) error {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /verify", func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBody))
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		data, err := v.verify(req.Context(), string(body))
		switch {
		case errors.Is(err, chatbot.ErrMiniAppInitData):
			http.Error(w, "init data rejected", http.StatusUnauthorized)
			return
		case err != nil:
			log.Printf("verify: %v", err)
			http.Error(w, "cannot verify now", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"user_id": data.User.ID, "chat_type": data.ChatType})
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			log.Printf("mini app backend: %v", err)
		}
	}()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	return nil
}
