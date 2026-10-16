package auth

import (
	"context"

	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
)

// resealBatch is how many sessions one ResealSessions query reads.
const resealBatch = 500

// sessionBoxes are the boxes of the stored IdP refresh and ID tokens.
func sessionBoxes(sessionKey, previousKey []byte) (refresh, idTokens *sealbox.Box, err error) {
	if refresh, err = sealbox.New(sessionKey, "idp refresh token", previousKey); err != nil {
		return nil, nil, err
	}
	if idTokens, err = sealbox.New(sessionKey, "idp id token", previousKey); err != nil {
		return nil, nil, err
	}
	return refresh, idTokens, nil
}

// ResealSessions seals every stored IdP token of tenant under sessionKey,
// opening it with sessionKey or previousKey (key rotation). A token neither
// opens is left as it is (the session's other token still moves) and its
// session counted as unreadable; a session changed meanwhile keeps its new
// tokens.
func ResealSessions(ctx context.Context, st *store.Store, tenantID string, sessionKey, previousKey []byte) (sealbox.Count, error) {
	var n sealbox.Count
	refresh, idTokens, err := sessionBoxes(sessionKey, previousKey)
	if err != nil {
		return n, err
	}
	var after int64
	for {
		rows, err := st.SealedSessions(ctx, tenantID, after, resealBatch)
		if err != nil || len(rows) == 0 {
			return n, err
		}
		for _, r := range rows {
			after = r.ID
			next := r
			changed, unreadable := false, false
			for _, f := range []struct {
				box *sealbox.Box
				val *[]byte
			}{{refresh, &next.RefreshTokenEnc}, {idTokens, &next.IDTokenEnc}} {
				if *f.val == nil {
					continue
				}
				out, ch, err := f.box.Reseal(*f.val, r.TokenHash)
				if err != nil {
					// Left as it is; the other token still moves.
					unreadable = true
					continue
				}
				*f.val, changed = out, changed || ch
			}
			if unreadable {
				n.Unreadable++
			} else if !changed {
				n.Current++
			}
			if changed {
				ok, err := st.ReplaceSealedTokens(ctx, r, next)
				if err != nil {
					return n, err
				}
				if ok && !unreadable {
					n.Resealed++
				}
			}
		}
	}
}
