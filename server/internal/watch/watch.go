// Package watch is the server's own watchdog: once a minute it checks what
// would hurt users (another tenant's process down, the machine short of
// memory or disk, a stale backup, a certificate about to expire, updates
// piling up in the outbox, errors in the log) and posts each problem into
// the tenant's "Vận hành chat" group, which it creates for the operators
// (CHAT_OPERATOR_USER_IDS), through an Alertmanager-format incoming hook:
// the message turns from firing to resolved in place. A problem must show
// in two checks in a row before it fires, so a deploy's restart does not.
// Problems of the machine are checked by the main tenant's process only.
// It cannot report the process it runs in being down (no extra channel
// until real users; host alerts belong to OneDash).
package watch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Every is the time between two checks.
const Every = time.Minute

// Problem is one thing wrong now.
type Problem struct {
	// Key names the problem stably (memory_low, tenant_down:inetdev).
	Key string
	// Name is the alert's name (MemoryLow).
	Name string
	// Severity is "warning" or "critical".
	Severity string
	Summary  string
	Detail   string
}

// Check finds the problems of one kind.
type Check func(ctx context.Context) ([]Problem, error)

// Chats creates the operators' group.
type Chats interface {
	CreateGroup(ctx context.Context, me int64, title string, userIDs []int64, forum bool) (*appv1.CreateGroupResponse, error)
}

// Hooks creates the group's alert source and posts through it.
type Hooks interface {
	CreateIncomingHook(ctx context.Context, me int64, req *appv1.CreateIncomingHookRequest) (*appv1.CreateIncomingHookResponse, error)
	Active(ctx context.Context, id string) (bool, error)
	PostAlertmanager(ctx context.Context, id string, body []byte) error
}

// Config wires a watcher.
type Config struct {
	TenantID  string
	Operators []int64
	Pool      *pgxpool.Pool
	Chats     Chats
	Hooks     Hooks
	Checks    []Check
	Logger    *slog.Logger
	// Now is the clock (tests).
	Now func() time.Time
}

// Watcher runs the checks and keeps the alerts.
type Watcher struct {
	cfg  Config
	seen map[string]int // problem key -> checks in a row it showed in
}

// New returns a watcher.
func New(cfg Config) *Watcher {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Watcher{cfg: cfg, seen: map[string]int{}}
}

// Run checks every minute until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	ticker := time.NewTicker(Every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := w.Once(ctx); err != nil && ctx.Err() == nil {
			w.cfg.Logger.Warn("watch: check failed", "err", err)
		}
	}
}

// Once runs every check and posts what changed.
func (w *Watcher) Once(ctx context.Context) error {
	var now []Problem
	for _, check := range w.cfg.Checks {
		found, err := check(ctx)
		if err != nil {
			w.cfg.Logger.Warn("watch: a check failed", "err", err)
			continue
		}
		now = append(now, found...)
	}
	// Firing needs two checks in a row; the others start over.
	current := map[string]bool{}
	var firing []Problem
	for _, p := range now {
		current[p.Key] = true
		w.seen[p.Key]++
		if w.seen[p.Key] >= 2 {
			firing = append(firing, p)
		}
	}
	for key := range w.seen {
		if !current[key] {
			delete(w.seen, key)
		}
	}
	return w.publish(ctx, firing)
}

// publish posts firing problems that are new and resolves stored ones that
// are gone.
func (w *Watcher) publish(ctx context.Context, firing []Problem) error {
	rows, err := w.cfg.Pool.Query(ctx, `SELECT key, name, summary, started_at FROM ops_alerts WHERE tenant_id = $1`, w.cfg.TenantID)
	if err != nil {
		return fmt.Errorf("watch: alerts: %w", err)
	}
	type alert struct {
		p       Problem
		started time.Time
	}
	stored := map[string]alert{}
	for rows.Next() {
		var a alert
		if err := rows.Scan(&a.p.Key, &a.p.Name, &a.p.Summary, &a.started); err != nil {
			rows.Close()
			return fmt.Errorf("watch: alerts: %w", err)
		}
		stored[a.p.Key] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("watch: alerts: %w", err)
	}
	now := w.cfg.Now()
	for _, p := range firing {
		a, ok := stored[p.Key]
		started := a.started
		if !ok {
			started = now
		}
		// Posting again an unchanged firing alert changes nothing in the chat.
		if err := w.post(ctx, p, "firing", started, time.Time{}); err != nil {
			return err
		}
		if !ok {
			w.cfg.Logger.Warn("watch: alert firing", "alert", p.Key, "summary", p.Summary)
			if _, err := w.cfg.Pool.Exec(ctx, `INSERT INTO ops_alerts (tenant_id, key, name, summary, started_at) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT DO NOTHING`, w.cfg.TenantID, p.Key, p.Name, p.Summary, started); err != nil {
				return fmt.Errorf("watch: store alert: %w", err)
			}
		}
	}
	for key, a := range stored {
		if slices.ContainsFunc(firing, func(p Problem) bool { return p.Key == key }) {
			continue
		}
		if err := w.post(ctx, a.p, "resolved", a.started, now); err != nil {
			return err
		}
		w.cfg.Logger.Info("watch: alert resolved", "alert", key)
		if _, err := w.cfg.Pool.Exec(ctx, `DELETE FROM ops_alerts WHERE tenant_id = $1 AND key = $2`, w.cfg.TenantID, key); err != nil {
			return fmt.Errorf("watch: drop alert: %w", err)
		}
	}
	return nil
}

type amAlert struct {
	Status      string            `json:"status"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	StartsAt    time.Time         `json:"startsAt"`
	EndsAt      time.Time         `json:"endsAt"`
	Fingerprint string            `json:"fingerprint"`
}

type amPayload struct {
	Receiver          string            `json:"receiver"`
	Status            string            `json:"status"`
	Alerts            []amAlert         `json:"alerts"`
	GroupLabels       map[string]string `json:"groupLabels"`
	CommonLabels      map[string]string `json:"commonLabels"`
	CommonAnnotations map[string]string `json:"commonAnnotations"`
	Version           string            `json:"version"`
	GroupKey          string            `json:"groupKey"`
}

// post sends one problem as an Alertmanager group of one alert.
func (w *Watcher) post(ctx context.Context, p Problem, status string, started, ended time.Time) error {
	hook, err := w.hook(ctx)
	if err != nil || hook == "" {
		return err
	}
	labels := map[string]string{"alertname": p.Name, "tenant": w.cfg.TenantID}
	if p.Severity != "" {
		labels["severity"] = p.Severity
	}
	annotations := map[string]string{"summary": p.Summary}
	if p.Detail != "" {
		annotations["description"] = p.Detail
	}
	body, err := json.Marshal(amPayload{
		Receiver: "chat-watch", Status: status, Version: "4", GroupKey: "chat-watch/" + p.Key,
		Alerts:      []amAlert{{Status: status, Labels: labels, Annotations: annotations, StartsAt: started, EndsAt: ended, Fingerprint: p.Key}},
		GroupLabels: map[string]string{"alertname": p.Name}, CommonLabels: labels, CommonAnnotations: annotations,
	})
	if err != nil {
		return err
	}
	if err := w.cfg.Hooks.PostAlertmanager(ctx, hook, body); err != nil {
		return fmt.Errorf("watch: post %s: %w", p.Key, err)
	}
	return nil
}

// hook is the incoming hook of the operators' group, created on first use;
// "" without operators (alerts then only reach the log).
func (w *Watcher) hook(ctx context.Context) (string, error) {
	if len(w.cfg.Operators) == 0 {
		return "", nil
	}
	var id string
	err := w.cfg.Pool.QueryRow(ctx, `SELECT hook_id FROM ops_alert_hooks WHERE tenant_id = $1`, w.cfg.TenantID).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("watch: alert hook: %w", err)
	}
	if id != "" {
		active, err := w.cfg.Hooks.Active(ctx, id)
		if err != nil || active {
			return id, err
		}
	}
	owner := w.cfg.Operators[0]
	group, err := w.cfg.Chats.CreateGroup(ctx, owner, "Vận hành chat", nil, false)
	if err != nil {
		return "", fmt.Errorf("watch: create the operators' group: %w", err)
	}
	created, err := w.cfg.Hooks.CreateIncomingHook(ctx, owner, &appv1.CreateIncomingHookRequest{
		ChatId: group.GetChat().GetId(), Name: "Giám sát", Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER,
		AllowAlert: true,
	})
	if err != nil {
		return "", fmt.Errorf("watch: create the alert hook: %w", err)
	}
	id = created.GetHook().GetId()
	if _, err := w.cfg.Pool.Exec(ctx, `INSERT INTO ops_alert_hooks (tenant_id, hook_id) VALUES ($1, $2)
		ON CONFLICT (tenant_id) DO UPDATE SET hook_id = excluded.hook_id`, w.cfg.TenantID, id); err != nil {
		return "", fmt.Errorf("watch: store the alert hook: %w", err)
	}
	w.cfg.Logger.Info("watch: created the operators' alert group", "chat_id", group.GetChat().GetId())
	return id, nil
}
