// Package agentgrant revokes, at the IdP, the grant of the tunelo sign-in
// that registered a machine once the machine is removed (from the web with
// RevokeMachine, or by tunelo logout with UnregisterMachine). Without it a
// removed machine could register again with its refresh token; after it, the
// machine only comes back through a new tunelo login that its owner
// approves.
//
// Removal never waits for the IdP: the store keeps the grant of every
// removed machine as pending (machines.grant_revoked_at unset) and Run
// works through them, at once when kicked and every few minutes otherwise,
// so an IdP that is down only delays the revocation.
package agentgrant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"app.local/server/internal/store"
)

const (
	// every is how often pending revocations are retried.
	every = 5 * time.Minute
	// batch bounds the revocations of one pass.
	batch = 50
	// callTimeout bounds one call to the IdP.
	callTimeout = 10 * time.Second
)

// ErrPermanent wraps an IdP answer that retrying cannot change (a request it
// refuses, a grant it does not know for that account).
var ErrPermanent = errors.New("agentgrant: permanent failure")

// Client revokes one tunelo-agent grant of the IdP account sub.
type Client interface {
	Revoke(ctx context.Context, sub, grantID string) error
}

// HTTPClient calls the IdP's grant revocation endpoint:
//
//	POST <url>
//	Authorization: Basic <client id>:<client secret> (form-encoded, RFC 6749 §2.3.1)
//	Content-Type: application/json
//	{"sub": "<account id>", "grant_id": "<grant id>"}
//
// 204 means revoked or already gone; 400 and 404 are permanent; anything
// else is retried later.
type HTTPClient struct {
	url          string
	clientID     string
	clientSecret string
	http         *http.Client
}

// NewHTTPClient returns a client of the endpoint at rawURL that
// authenticates as clientID with clientSecret (the chat's own IdP client).
func NewHTTPClient(rawURL, clientID, clientSecret string, hc *http.Client) (*HTTPClient, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("agentgrant: the revocation URL must be an absolute http(s) URL")
	}
	if clientID == "" || clientSecret == "" {
		return nil, errors.New("agentgrant: client credentials are required")
	}
	if hc == nil {
		hc = &http.Client{Timeout: callTimeout}
	}
	return &HTTPClient{url: rawURL, clientID: clientID, clientSecret: clientSecret, http: hc}, nil
}

// Revoke implements Client.
func (c *HTTPClient) Revoke(ctx context.Context, sub, grantID string) error {
	body, err := json.Marshal(map[string]string{"sub": sub, "grant_id": grantID})
	if err != nil {
		return fmt.Errorf("agentgrant: encode: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("agentgrant: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(url.QueryEscape(c.clientID), url.QueryEscape(c.clientSecret))
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("agentgrant: revoke: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// The error body is a short JSON object; read a little for the log.
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	switch {
	case resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%w: status %d %s", ErrPermanent, resp.StatusCode, bytes.TrimSpace(detail))
	default:
		return fmt.Errorf("agentgrant: revoke: status %d %s", resp.StatusCode, bytes.TrimSpace(detail))
	}
}

// Store is what the Revoker needs of the store.
type Store interface {
	PendingGrantRevocations(ctx context.Context, tenantID string, limit int) ([]store.GrantRevocation, error)
	MarkGrantRevoked(ctx context.Context, tenantID string, machineID int64, grantID string) error
}

// Revoker works through the pending revocations.
type Revoker struct {
	store    Store
	client   Client
	tenantID string
	logger   *slog.Logger
	kick     chan struct{}
}

// New returns a Revoker; client nil turns revocation off (the grants stay
// pending, for a later start with an endpoint configured).
func New(st Store, client Client, tenantID string, logger *slog.Logger) *Revoker {
	return &Revoker{store: st, client: client, tenantID: tenantID, logger: logger, kick: make(chan struct{}, 1)}
}

// Kick asks Run for a pass now (a machine was just removed). It never
// blocks.
func (r *Revoker) Kick() {
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

// Run revokes pending grants until ctx ends: at start, when kicked and
// every few minutes.
func (r *Revoker) Run(ctx context.Context) {
	if r.client == nil {
		r.logger.Warn("tunelo grant revocation is off (TUNELO_GRANT_REVOKE_URL unset): removed machines keep their IdP grant")
		return
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		if _, err := r.RunOnce(ctx); err != nil && ctx.Err() == nil {
			r.logger.Warn("tunelo grant revocation pass failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-r.kick:
		}
	}
}

// RunOnce revokes one batch of pending grants and returns how many it took
// off the queue. A grant the IdP fails on now stays pending; one it refuses
// for good is logged and no longer retried.
func (r *Revoker) RunOnce(ctx context.Context) (int, error) {
	if r.client == nil {
		return 0, nil
	}
	pending, err := r.store.PendingGrantRevocations(ctx, r.tenantID, batch)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, g := range pending {
		err := r.client.Revoke(ctx, g.OwnerSub, g.GrantID)
		switch {
		case err == nil:
			r.logger.Info("removed machine's grant revoked", "machine_id", g.MachineID)
		case errors.Is(err, ErrPermanent):
			// Recorded as handled so it is not retried forever.
			r.logger.Error("the IdP refused to revoke a removed machine's grant; not retried", "machine_id", g.MachineID, "err", err)
		default:
			if ctx.Err() != nil {
				return done, ctx.Err()
			}
			r.logger.Warn("revoking a removed machine's grant failed; retried later", "machine_id", g.MachineID, "err", err)
			continue
		}
		if err := r.store.MarkGrantRevoked(ctx, r.tenantID, g.MachineID, g.GrantID); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}
