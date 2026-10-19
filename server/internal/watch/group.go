package watch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"unicode/utf16"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// GroupTitle is the title of the operators' group.
const GroupTitle = "Vận hành chat"

// GroupConfig wires the operators' group.
type GroupConfig struct {
	TenantID string
	// Operators of the tenant (CHAT_OPERATOR_USER_IDS); the first one owns
	// the group. None: nothing is posted.
	Operators []int64
	Pool      *pgxpool.Pool
	Chats     Chats
	Hooks     Hooks
	Logger    *slog.Logger
}

// Group is the tenant's "Vận hành chat" group: the watchdog's alerts, the
// notices of new feedback and reports, and the daily digest go there
// through one incoming hook, created with the group on first use.
type Group struct {
	cfg GroupConfig
	// mu keeps two posters of this process from creating two groups.
	mu sync.Mutex
}

// NewGroup returns the tenant's operators' group.
func NewGroup(cfg GroupConfig) *Group {
	return &Group{cfg: cfg}
}

// Hook is the incoming hook of the operators' group, created on first use;
// "" without operators (alerts then only reach the log).
func (g *Group) Hook(ctx context.Context) (string, error) {
	if len(g.cfg.Operators) == 0 {
		return "", nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	var id string
	err := g.cfg.Pool.QueryRow(ctx, `SELECT hook_id FROM ops_alert_hooks WHERE tenant_id = $1`, g.cfg.TenantID).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("watch: alert hook: %w", err)
	}
	if id != "" {
		active, err := g.cfg.Hooks.Active(ctx, id)
		if err != nil || active {
			return id, err
		}
	}
	owner := g.cfg.Operators[0]
	group, err := g.cfg.Chats.CreateGroup(ctx, owner, GroupTitle, nil, false)
	if err != nil {
		return "", fmt.Errorf("watch: create the operators' group: %w", err)
	}
	created, err := g.cfg.Hooks.CreateIncomingHook(ctx, owner, &appv1.CreateIncomingHookRequest{
		ChatId: group.GetChat().GetId(), Name: "Giám sát", Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER,
		AllowAlert: true,
	})
	if err != nil {
		return "", fmt.Errorf("watch: create the alert hook: %w", err)
	}
	id = created.GetHook().GetId()
	if _, err := g.cfg.Pool.Exec(ctx, `INSERT INTO ops_alert_hooks (tenant_id, hook_id) VALUES ($1, $2)
		ON CONFLICT (tenant_id) DO UPDATE SET hook_id = excluded.hook_id`, g.cfg.TenantID, id); err != nil {
		return "", fmt.Errorf("watch: store the alert hook: %w", err)
	}
	g.cfg.Logger.Info("watch: created the operators' alert group", "chat_id", group.GetChat().GetId())
	return id, nil
}

// Notice is a message for the operators' group.
type Notice struct {
	text     strings.Builder
	entities []noticeEntity
	buttons  []noticeButton
	// Key makes the notice post once (the hook's idempotency key, a day).
	Key string
}

type noticeEntity struct {
	Type   string `json:"type"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
}

type noticeButton struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

// utf16Len is the length of s in UTF-16 code units (entity offsets).
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// Write appends plain text.
func (n *Notice) Write(s string) *Notice {
	n.text.WriteString(s)
	return n
}

// Bold appends bold text.
func (n *Notice) Bold(s string) *Notice {
	if s == "" {
		return n
	}
	n.entities = append(n.entities, noticeEntity{Type: "bold", Offset: utf16Len(n.text.String()), Length: utf16Len(s)})
	n.text.WriteString(s)
	return n
}

// Button adds a link button below the text.
func (n *Notice) Button(text, url string) *Notice {
	if url != "" {
		n.buttons = append(n.buttons, noticeButton{Text: text, URL: url})
	}
	return n
}

// Text is the notice's text so far.
func (n *Notice) Text() string {
	return n.text.String()
}

// Post sends n into the operators' group; without operators it only logs.
func (g *Group) Post(ctx context.Context, what string, n *Notice) error {
	hook, err := g.Hook(ctx)
	if err != nil {
		return err
	}
	if hook == "" {
		g.cfg.Logger.Info("watch: no operators' group; notice not posted", "notice", what)
		return nil
	}
	payload := struct {
		Text           string         `json:"text"`
		Entities       []noticeEntity `json:"entities,omitempty"`
		Buttons        []noticeButton `json:"buttons,omitempty"`
		IdempotencyKey string         `json:"idempotency_key,omitempty"`
	}{Text: n.Text(), Entities: n.entities, Buttons: n.buttons, IdempotencyKey: n.Key}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := g.cfg.Hooks.PostNative(ctx, hook, body); err != nil {
		return fmt.Errorf("watch: post %s: %w", what, err)
	}
	return nil
}
