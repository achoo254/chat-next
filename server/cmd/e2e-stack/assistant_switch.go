package main

import (
	"net/http"

	"app.local/server/internal/api"
)

// assistantSwitchPath turns the assistant chat off and on, so a scenario
// can sign in an account "before the assistant was released" and then see
// the chat arrive on its next start, as an existing user did:
//
//	POST /e2e/assistant?state=off   app starts create no assistant chat
//	POST /e2e/assistant?state=on    they do again (the default)
//
// Like /e2e/realtime it is called on the api port, never through Vite.
const assistantSwitchPath = "/e2e/assistant"

func assistantSwitch(app *api.App, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != assistantSwitchPath {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if app.Assistant == nil {
			http.Error(w, "the assistant is not set up", http.StatusConflict)
			return
		}
		switch r.URL.Query().Get("state") {
		case "off":
			app.Chat.SetSystemBot(0)
		case "on":
			app.Chat.SetSystemBot(app.Assistant.BotID())
		default:
			http.Error(w, `state must be "off" or "on"`, http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
