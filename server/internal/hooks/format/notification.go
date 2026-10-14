// Package format turns incoming webhook payloads (our JSON, Slack and
// Mattermost compatible, Alertmanager, Grafana, GitLab) into one
// Notification: text with entities (ADR 0004), URL buttons and the delivery
// controls (idempotency, alert group, status, silence, priority).
package format

import (
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// Kind names a payload format; it is also the URL suffix (native has none).
type Kind string

// Formats.
const (
	Native       Kind = "native"
	Slack        Kind = "slack"
	Alertmanager Kind = "alertmanager"
	Grafana      Kind = "grafana"
	GitLab       Kind = "gitlab"
)

// Kinds lists every format.
var Kinds = []Kind{Native, Slack, Alertmanager, Grafana, GitLab}

// Valid reports whether k is a known format.
func (k Kind) Valid() bool {
	for _, known := range Kinds {
		if k == known {
			return true
		}
	}
	return false
}

// Suffix is the URL path suffix of the format ("" or "/slack" ...).
func (k Kind) Suffix() string {
	if k == Native {
		return ""
	}
	return "/" + string(k)
}

// Priorities of a notification.
const (
	PriorityTransactional = "transactional"
	PriorityAlert         = "alert"
)

// Limits of a notification.
const (
	idempotencyKeyMax = 128
	groupKeyMax       = 256
	statusMax         = 32
	buttonRowsMax     = 8
	buttonsPerRowMax  = 8
	buttonTextMax     = 64
)

// Button opens URL.
type Button struct {
	Text string
	URL  string
}

// Notification is a parsed payload.
type Notification struct {
	Text     string
	Entities []*appv1.MessageEntity
	Buttons  [][]Button
	Silent   bool
	// IdempotencyKey: retries with the same key return the first result.
	IdempotencyKey string
	// GroupKey: the message of the previous notification with this key is
	// updated in place.
	GroupKey string
	// Status of the alert group ("firing", "resolved", or any word); a
	// change of status notifies again, a repeat does not.
	Status string
	// SourceTime orders updates of a group; zero means "when received".
	SourceTime time.Time
	// Priority is PriorityTransactional or PriorityAlert.
	Priority string
	// Ignored: the payload is valid but carries nothing to post (an event
	// kind the format skips).
	Ignored bool
}

// Options are the server settings the mappers need.
type Options struct {
	// AppScheme is the app's own URL scheme allowed in links (ADR 0004).
	AppScheme string
	// MaxLength is the message length limit in code points.
	MaxLength int
	// Location formats times in alert texts.
	Location *time.Location
}

// Error is a payload the hook cannot process; Reason is a stable code
// (invalid_json, invalid_payload, text_empty, text_too_long,
// url_not_allowed, unsupported_media_type).
type Error struct {
	Reason string
	Detail string
}

func (e *Error) Error() string {
	return e.Reason + ": " + e.Detail
}

func errorf(reason, format string, args ...any) error {
	return &Error{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

// AsError returns the payload error inside err, if any.
func AsError(err error) (*Error, bool) {
	var fe *Error
	ok := errors.As(err, &fe)
	return fe, ok
}

// Parse maps a request body of the given format.
func Parse(kind Kind, contentType string, body []byte, opts Options) (*Notification, error) {
	if opts.Location == nil {
		opts.Location = time.UTC
	}
	var (
		n   *Notification
		err error
	)
	switch kind {
	case Native:
		n, err = parseNative(body, opts)
	case Slack:
		n, err = parseSlack(contentType, body, opts)
	case Alertmanager:
		n, err = parseAlertmanager(body, opts, false)
	case Grafana:
		n, err = parseAlertmanager(body, opts, true)
	case GitLab:
		n, err = parseGitLab(body, opts)
	default:
		return nil, errorf("invalid_payload", "unknown format %q", kind)
	}
	if err != nil {
		return nil, err
	}
	if n.Ignored {
		return n, nil
	}
	if n.Priority == "" {
		n.Priority = PriorityTransactional
	}
	return n, checkControls(n)
}

// checkControls bounds the delivery fields every format may set.
func checkControls(n *Notification) error {
	switch {
	case len(n.IdempotencyKey) > idempotencyKeyMax:
		return errorf("invalid_payload", "idempotency_key is longer than %d bytes", idempotencyKeyMax)
	case len(n.GroupKey) > groupKeyMax:
		// Alertmanager group keys can be long: keep them unique but short.
		n.GroupKey = hashKey(n.GroupKey)
	}
	if len(n.Status) > statusMax {
		n.Status = n.Status[:statusMax]
	}
	if n.Priority != PriorityTransactional && n.Priority != PriorityAlert {
		return errorf("invalid_payload", "priority must be %q or %q", PriorityTransactional, PriorityAlert)
	}
	if len(n.Buttons) > buttonRowsMax {
		return errorf("invalid_payload", "at most %d button rows", buttonRowsMax)
	}
	for _, row := range n.Buttons {
		if len(row) > buttonsPerRowMax {
			return errorf("invalid_payload", "at most %d buttons per row", buttonsPerRowMax)
		}
	}
	return nil
}
