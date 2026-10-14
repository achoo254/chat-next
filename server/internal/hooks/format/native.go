package format

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

// nativePayload is our own JSON format.
type nativePayload struct {
	Text string `json:"text"`
	// Entities as in ADR 0004 (UTF-16 offsets); exclusive with parse_mode.
	Entities []nativeEntity `json:"entities"`
	// "markdown" (Telegram style) or "mrkdwn" (Slack style); empty for
	// plain text or explicit entities.
	ParseMode string `json:"parse_mode"`
	// Rows of buttons ([[{...}]]) or one row ([{...}]).
	Buttons        json.RawMessage `json:"buttons"`
	Silent         bool            `json:"silent"`
	IdempotencyKey string          `json:"idempotency_key"`
	GroupKey       string          `json:"group_key"`
	Status         string          `json:"status"`
	Priority       string          `json:"priority"`
	// RFC 3339 string or unix seconds; orders updates of a group.
	Timestamp json.RawMessage `json:"timestamp"`
}

type nativeEntity struct {
	Type     string `json:"type"`
	Offset   int32  `json:"offset"`
	Length   int32  `json:"length"`
	URL      string `json:"url"`
	UserID   int64  `json:"user_id"`
	Language string `json:"language"`
}

var nativeEntityTypes = map[string]appv1.EntityType{
	"bold":          appv1.EntityType_ENTITY_TYPE_BOLD,
	"italic":        appv1.EntityType_ENTITY_TYPE_ITALIC,
	"underline":     appv1.EntityType_ENTITY_TYPE_UNDERLINE,
	"strike":        appv1.EntityType_ENTITY_TYPE_STRIKE,
	"strikethrough": appv1.EntityType_ENTITY_TYPE_STRIKE,
	"spoiler":       appv1.EntityType_ENTITY_TYPE_SPOILER,
	"code":          appv1.EntityType_ENTITY_TYPE_CODE,
	"pre":           appv1.EntityType_ENTITY_TYPE_PRE,
	"text_link":     appv1.EntityType_ENTITY_TYPE_TEXT_LINK,
	"mention":       appv1.EntityType_ENTITY_TYPE_MENTION,
	"mention_name":  appv1.EntityType_ENTITY_TYPE_MENTION_NAME,
	"text_mention":  appv1.EntityType_ENTITY_TYPE_MENTION_NAME,
	"hashtag":       appv1.EntityType_ENTITY_TYPE_HASHTAG,
	"url":           appv1.EntityType_ENTITY_TYPE_URL,
	"email":         appv1.EntityType_ENTITY_TYPE_EMAIL,
	"bot_command":   appv1.EntityType_ENTITY_TYPE_BOT_COMMAND,
}

type nativeButton struct {
	Text string `json:"text"`
	URL  string `json:"url"`
}

func decodeJSON(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(v); err != nil {
		return errorf("invalid_json", "the body is not valid JSON: %s", jsonProblem(err))
	}
	return nil
}

// jsonProblem describes a decoding error without echoing payload values.
func jsonProblem(err error) string {
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return "syntax error at byte " + strconv.FormatInt(syntax.Offset, 10)
	}
	var typ *json.UnmarshalTypeError
	if errors.As(err, &typ) {
		return "field " + strconv.Quote(typ.Field) + " has the wrong type"
	}
	return "unexpected end or shape"
}

func parseNative(body []byte, opts Options) (*Notification, error) {
	var p nativePayload
	if err := decodeJSON(body, &p); err != nil {
		return nil, err
	}
	b := newBuilder(opts)
	switch strings.ToLower(p.ParseMode) {
	case "":
		if len(p.Entities) == 0 {
			b.write(cleanText(p.Text))
			break
		}
		b.write(p.Text)
		for i, e := range p.Entities {
			t, ok := nativeEntityTypes[strings.ToLower(e.Type)]
			if !ok {
				return nil, errorf("invalid_payload", "entity %d has an unknown type", i)
			}
			if t == appv1.EntityType_ENTITY_TYPE_TEXT_LINK && !entities.IsAllowedURL(e.URL, opts.AppScheme) {
				return nil, errorf("url_not_allowed", "entity %d links to a URL that is not allowed", i)
			}
			b.ents = append(b.ents, &appv1.MessageEntity{Type: t, Offset: e.Offset, Length: e.Length, Url: e.URL,
				UserId: e.UserID, Language: e.Language})
		}
	case "markdown", "markdownv2":
		if len(p.Entities) > 0 {
			return nil, errorf("invalid_payload", "entities and parse_mode cannot be combined")
		}
		b.markup(p.Text, dialectMarkdown)
	case "mrkdwn", "slack":
		if len(p.Entities) > 0 {
			return nil, errorf("invalid_payload", "entities and parse_mode cannot be combined")
		}
		b.markup(p.Text, dialectSlack)
	default:
		return nil, errorf("invalid_payload", "parse_mode must be markdown or mrkdwn")
	}
	text, ents, err := b.finish(true)
	if err != nil {
		return nil, err
	}
	buttons, err := nativeButtons(p.Buttons, opts)
	if err != nil {
		return nil, err
	}
	ts, err := parseTimestamp(p.Timestamp)
	if err != nil {
		return nil, err
	}
	return &Notification{
		Text: text, Entities: ents, Buttons: buttons, Silent: p.Silent,
		IdempotencyKey: p.IdempotencyKey, GroupKey: p.GroupKey, Status: strings.ToLower(strings.TrimSpace(p.Status)),
		SourceTime: ts, Priority: strings.ToLower(p.Priority),
	}, nil
}

// nativeButtons accepts rows ([[{...}]]) or a single row ([{...}]); every
// URL must be allowed (ADR 0004).
func nativeButtons(raw json.RawMessage, opts Options) ([][]Button, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var rows [][]nativeButton
	if err := json.Unmarshal(raw, &rows); err != nil {
		var row []nativeButton
		if err := json.Unmarshal(raw, &row); err != nil {
			return nil, errorf("invalid_payload", "buttons must be a list of {text, url} or a list of such rows")
		}
		rows = [][]nativeButton{row}
	}
	var out [][]Button
	for _, row := range rows {
		var r []Button
		for _, nb := range row {
			if strings.TrimSpace(nb.Text) == "" {
				return nil, errorf("invalid_payload", "every button needs a text")
			}
			if !entities.IsAllowedURL(nb.URL, opts.AppScheme) {
				return nil, errorf("url_not_allowed", "a button links to a URL that is not allowed")
			}
			r = append(r, Button{Text: cleanText(nb.Text), URL: nb.URL})
		}
		if len(r) > 0 {
			out = append(out, r)
		}
	}
	return out, nil
}

// parseTimestamp reads an RFC 3339 string or unix seconds (milliseconds
// when above 10^12).
func parseTimestamp(raw json.RawMessage) (time.Time, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return time.Time{}, nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return time.Time{}, errorf("invalid_payload", "timestamp must be RFC 3339 or unix seconds")
		}
		return t, nil
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil || n < 0 {
		return time.Time{}, errorf("invalid_payload", "timestamp must be RFC 3339 or unix seconds")
	}
	if n > 1e12 {
		return time.UnixMilli(int64(n)), nil
	}
	return time.Unix(int64(n), 0), nil
}
