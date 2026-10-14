package format

import (
	"encoding/json"
	"mime"
	"net/url"
	"strings"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

// slackPayload is the subset of a Slack incoming webhook message (also sent
// by Mattermost-compatible tools) that maps onto a chat message.
type slackPayload struct {
	Text        string            `json:"text"`
	Mrkdwn      *bool             `json:"mrkdwn"`
	Blocks      []slackBlock      `json:"blocks"`
	Attachments []slackAttachment `json:"attachments"`
}

type slackText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type slackBlock struct {
	Type      string         `json:"type"`
	Text      *slackText     `json:"text"`
	Fields    []slackText    `json:"fields"`
	Elements  []slackElement `json:"elements"`
	Accessory *slackElement  `json:"accessory"`
}

// slackElement is a context text, a button or an image; Text is a string
// for context texts and a text object for buttons.
type slackElement struct {
	Type string          `json:"type"`
	Text json.RawMessage `json:"text"`
	URL  string          `json:"url"`
}

type slackField struct {
	Title string `json:"title"`
	Value string `json:"value"`
}

type slackAction struct {
	Type string `json:"type"`
	Text string `json:"text"`
	URL  string `json:"url"`
}

type slackAttachment struct {
	Fallback   string        `json:"fallback"`
	Pretext    string        `json:"pretext"`
	AuthorName string        `json:"author_name"`
	AuthorLink string        `json:"author_link"`
	Title      string        `json:"title"`
	TitleLink  string        `json:"title_link"`
	Text       string        `json:"text"`
	Fields     []slackField  `json:"fields"`
	Footer     string        `json:"footer"`
	Actions    []slackAction `json:"actions"`
	Blocks     []slackBlock  `json:"blocks"`
}

// slackBody returns the JSON of a Slack request: the body itself, or the
// payload field of a form post (legacy Slack clients, some Jenkins plugins).
func slackBody(contentType string, body []byte) ([]byte, error) {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "application/x-www-form-urlencoded" {
		return body, nil
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, errorf("invalid_payload", "the form body cannot be parsed")
	}
	payload := form.Get("payload")
	if payload == "" {
		return nil, errorf("invalid_payload", "the form has no payload field")
	}
	return []byte(payload), nil
}

func parseSlack(contentType string, body []byte, opts Options) (*Notification, error) {
	raw, err := slackBody(contentType, body)
	if err != nil {
		return nil, err
	}
	var p slackPayload
	if err := decodeJSON(raw, &p); err != nil {
		return nil, err
	}
	b := newBuilder(opts)
	var buttons [][]Button
	if len(p.Blocks) > 0 {
		buttons = append(buttons, b.slackBlocks(p.Blocks)...)
	}
	if b.empty() {
		if p.Mrkdwn != nil && !*p.Mrkdwn {
			b.write(cleanText(p.Text))
		} else {
			b.markup(p.Text, dialectSlack)
		}
	}
	for _, a := range p.Attachments {
		buttons = append(buttons, b.slackAttachment(a)...)
	}
	text, ents, err := b.finish(false)
	if err != nil {
		return nil, err
	}
	return &Notification{Text: text, Entities: ents, Buttons: keepButtons(buttons, opts)}, nil
}

// slackBlocks renders section, header, context, divider and actions blocks
// and returns the URL buttons they carry.
func (b *builder) slackBlocks(blocks []slackBlock) [][]Button {
	var buttons [][]Button
	for _, bl := range blocks {
		switch bl.Type {
		case "header":
			if bl.Text != nil {
				b.newline()
				b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, cleanText(bl.Text.Text))
			}
		case "section":
			if bl.Text != nil {
				b.newline()
				b.slackText(*bl.Text)
			}
			for _, f := range bl.Fields {
				b.newline()
				b.slackText(f)
			}
			if bt, ok := bl.Accessory.button(); ok {
				buttons = append(buttons, []Button{bt})
			}
		case "context":
			b.newline()
			first := true
			for _, el := range bl.Elements {
				var s string
				if (el.Type == "mrkdwn" || el.Type == "plain_text") && json.Unmarshal(el.Text, &s) == nil {
					if !first {
						b.write(" ")
					}
					b.slackText(slackText{Type: el.Type, Text: s})
					first = false
				}
			}
		case "actions":
			var row []Button
			for i := range bl.Elements {
				if bt, ok := bl.Elements[i].button(); ok {
					row = append(row, bt)
				}
			}
			if len(row) > 0 {
				buttons = append(buttons, row)
			}
		case "divider":
			b.newline()
		default:
		}
	}
	return buttons
}

// button returns the URL button of an element, if it is one.
func (el *slackElement) button() (Button, bool) {
	if el == nil || el.Type != "button" || el.URL == "" {
		return Button{}, false
	}
	var t slackText
	if json.Unmarshal(el.Text, &t) != nil || strings.TrimSpace(t.Text) == "" {
		return Button{}, false
	}
	return Button{Text: cleanText(t.Text), URL: el.URL}, true
}

func (b *builder) slackText(t slackText) {
	if t.Type == "plain_text" {
		b.write(cleanText(t.Text))
		return
	}
	b.markup(t.Text, dialectSlack)
}

// slackAttachment renders a legacy attachment (Grafana, GitLab through
// Mattermost, Jenkins): pretext, author, linked title, text, fields,
// blocks and footer, or its fallback when all are empty.
func (b *builder) slackAttachment(a slackAttachment) [][]Button {
	before := b.n
	if a.Pretext != "" {
		b.newline()
		b.markup(a.Pretext, dialectSlack)
	}
	if a.AuthorName != "" {
		b.newline()
		b.link(cleanText(a.AuthorName), a.AuthorLink)
	}
	if a.Title != "" {
		b.newline()
		start := b.n
		if a.TitleLink != "" {
			b.link(cleanText(a.Title), a.TitleLink)
		} else {
			b.write(cleanText(a.Title))
		}
		b.mark(appv1.EntityType_ENTITY_TYPE_BOLD, start)
	}
	if a.Text != "" {
		b.newline()
		b.markup(a.Text, dialectSlack)
	}
	for _, f := range a.Fields {
		if f.Title == "" && f.Value == "" {
			continue
		}
		b.newline()
		if f.Title != "" {
			b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, cleanText(f.Title))
			b.write(": ")
		}
		b.markup(f.Value, dialectSlack)
	}
	buttons := b.slackBlocks(a.Blocks)
	if a.Footer != "" {
		b.newline()
		b.styled(appv1.EntityType_ENTITY_TYPE_ITALIC, cleanText(a.Footer))
	}
	if b.n == before && a.Fallback != "" {
		b.newline()
		b.markup(a.Fallback, dialectSlack)
	}
	var row []Button
	for _, act := range a.Actions {
		if act.URL != "" && strings.TrimSpace(act.Text) != "" {
			row = append(row, Button{Text: cleanText(act.Text), URL: act.URL})
		}
	}
	if len(row) > 0 {
		buttons = append(buttons, row)
	}
	return buttons
}

// keepButtons drops buttons whose URL is not allowed and bounds the rows,
// for formats that come from tools the admin does not control.
func keepButtons(rows [][]Button, opts Options) [][]Button {
	var out [][]Button
	for _, row := range rows {
		var kept []Button
		for _, bt := range row {
			if entities.IsAllowedURL(bt.URL, opts.AppScheme) && len(kept) < buttonsPerRowMax {
				if r := []rune(bt.Text); len(r) > buttonTextMax {
					bt.Text = string(r[:buttonTextMax-1]) + "…"
				}
				kept = append(kept, bt)
			}
		}
		if len(kept) > 0 && len(out) < buttonRowsMax {
			out = append(out, kept)
		}
	}
	return out
}
