package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"app.local/server/internal/accountdeleted"
	"app.local/server/internal/auth/idptest"
)

// privacyPath plays the IdP deleting an account, so a scenario can see the
// chat erase it (ADR 0016):
//
//	POST /e2e/privacy?action=idp-delete&sub=acc_e2e_khoa
//
// signs the IdP's account.deleted SET for sub with the fake IdP's key and
// hands it to the real endpoint (accountdeleted.Path), answering with its
// status. Like /e2e/realtime it is called on the api port, never through
// Vite.
const privacyPath = "/e2e/privacy"

func privacySwitch(idp *idptest.Provider, public string, next http.Handler) http.Handler {
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
		q := r.URL.Query()
		sub := q.Get("sub")
		if q.Get("action") != "idp-delete" || sub == "" {
			http.Error(w, `action must be "idp-delete", with a sub`, http.StatusBadRequest)
			return
		}
		now := time.Now()
		set, err := idp.Sign(map[string]any{
			"iss": idp.Issuer(), "aud": strings.TrimRight(public, "/") + accountdeleted.Path, "sub": sub, "jti": "e2e-" + sub,
			"iat": now.Unix(), "exp": now.Add(10 * time.Minute).Unix(), "toe": now.Unix(),
			"events": map[string]any{accountdeleted.Event: map[string]any{}},
		}, "secevent+jwt")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		req := httptest.NewRequestWithContext(r.Context(), http.MethodPost, accountdeleted.Path, strings.NewReader(set))
		req.Header.Set("Content-Type", "application/secevent+jwt")
		rec := httptest.NewRecorder()
		next.ServeHTTP(rec, req)
		w.WriteHeader(rec.Code)
	})
}
