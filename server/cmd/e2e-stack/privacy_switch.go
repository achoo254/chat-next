package main

import (
	"net/http"

	"app.local/server/internal/api"
	"app.local/server/internal/store"
)

// privacyPath fast-forwards account deletion, so a scenario can see an
// account erased without waiting 30 days:
//
//	POST /e2e/privacy?action=purge   end every running grace period and run
//	                                 the privacy jobs (erasure, auto-delete
//	                                 scan, export expiry) at once
//
// Like /e2e/realtime it is called on the api port, never through Vite.
const privacyPath = "/e2e/privacy"

func privacySwitch(app *api.App, st *store.Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != privacyPath {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Query().Get("action") != "purge" {
			http.Error(w, `action must be "purge"`, http.StatusBadRequest)
			return
		}
		if _, err := st.Pool().Exec(r.Context(), `
			UPDATE users SET deletion_requested_at = deletion_requested_at - interval '31 days'
			WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL`); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		app.Privacy.RunJobs(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
}
