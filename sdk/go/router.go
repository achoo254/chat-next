package chatbot

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
)

// Handler handles one routed update.
type Handler func(ctx context.Context, c *Context) error

// Context is what a Router passes to a handler: the update, the client and
// shortcuts to answer it.
type Context struct {
	// Update is the update being handled.
	Update Update
	// Client is the router's client.
	Client *Client
	// Args is the text after a command, trimmed; empty for other updates.
	Args string
}

// Message returns the message of the update (also of a channel post, an
// edit, or the message whose button was pressed), or nil.
func (c *Context) Message() *Message {
	u := c.Update
	switch {
	case u.Message != nil:
		return u.Message
	case u.ChannelPost != nil:
		return u.ChannelPost
	case u.MessageEdited != nil:
		return u.MessageEdited
	case u.Callback != nil:
		return &u.Callback.Message
	}
	return nil
}

// Reply sends text into the chat of the update's message (for a button press:
// the chat of the message with the button), in the same topic. opts, when
// given, supplies the other fields; its ChatID and Text are replaced.
func (c *Context) Reply(ctx context.Context, text string, opts *SendMessageRequest) (*Message, error) {
	msg := c.Message()
	if msg == nil {
		return nil, errors.New("chatbot: Reply needs an update with a message")
	}
	var req SendMessageRequest
	if opts != nil {
		req = *opts
	}
	req.ChatID = msg.Chat.ID
	req.Text = text
	if req.TopicID == 0 {
		req.TopicID = msg.TopicID
	}
	return c.Client.SendMessage(ctx, req)
}

// Answer answers the update's button press with an optional toast text (or a
// dialog with showAlert).
func (c *Context) Answer(ctx context.Context, text string, showAlert bool) error {
	if c.Update.Callback == nil {
		return errors.New("chatbot: Answer needs a callback update")
	}
	return c.Client.AnswerCallback(ctx, c.Update.Callback.ID, AnswerCallbackRequest{Text: text, ShowAlert: showAlert})
}

// AnswerInline answers the update's inline query. opts, when given, supplies
// the other fields; its Results are replaced.
func (c *Context) AnswerInline(ctx context.Context, results []InlineQueryResult, opts *AnswerInlineQueryRequest) error {
	if c.Update.InlineQuery == nil {
		return errors.New("chatbot: AnswerInline needs an inline_query update")
	}
	var req AnswerInlineQueryRequest
	if opts != nil {
		req = *opts
	}
	req.Results = results
	if req.Results == nil {
		req.Results = []InlineQueryResult{}
	}
	return c.Client.AnswerInlineQuery(ctx, c.Update.InlineQuery.ID, req)
}

// Router dispatches updates to handlers. Its Handle method is a HandlerFunc
// for both Poll and WebhookHandler. Register handlers before receiving
// updates; Handle is safe for concurrent use.
type Router struct {
	client    *Client
	commands  map[string]Handler
	callbacks []prefixRoute
	inline    Handler
	message   Handler
	kinds     map[UpdateKind]Handler

	mu       sync.Mutex
	username string
	known    bool
}

type prefixRoute struct {
	prefix string
	fn     Handler
}

// NewRouter returns a router whose handlers use client.
func NewRouter(client *Client) *Router {
	return &Router{client: client, commands: map[string]Handler{}, kinds: map[UpdateKind]Handler{}}
}

// Command handles messages starting with the bot_command "/name" (or
// "/name@username" when username is the bot's). Names match case-insensitively
// and are given without the slash.
func (r *Router) Command(name string, fn Handler) {
	r.commands[strings.ToLower(strings.TrimPrefix(name, "/"))] = fn
}

// Callback handles button presses whose data starts with prefix; the longest
// matching prefix wins.
func (r *Router) Callback(prefix string, fn Handler) {
	r.callbacks = append(r.callbacks, prefixRoute{prefix: prefix, fn: fn})
	sort.SliceStable(r.callbacks, func(i, j int) bool {
		return len(r.callbacks[i].prefix) > len(r.callbacks[j].prefix)
	})
}

// InlineQuery handles inline_query updates.
func (r *Router) InlineQuery(fn Handler) { r.inline = fn }

// Message handles every message that no command matched.
func (r *Router) Message(fn Handler) { r.message = fn }

// On handles another kind of update, such as UpdateKindMessageEdited,
// UpdateKindChannelPost, UpdateKindMemberChanged or UpdateKindReaction. For
// messages, callbacks and inline queries it is the fallback when no more
// specific handler matched.
func (r *Router) On(kind UpdateKind, fn Handler) { r.kinds[kind] = fn }

// Handle routes one update. Unknown kinds and updates without a handler are
// ignored. It never returns a WebhookAnswer; handlers call the API through
// Context.
func (r *Router) Handle(ctx context.Context, u Update) (*WebhookAnswer, error) {
	kind := updateKind(u)
	if kind == "" {
		return nil, nil
	}
	c := &Context{Update: u, Client: r.client}
	fn, err := r.route(ctx, kind, c)
	if err != nil || fn == nil {
		return nil, err
	}
	return nil, fn(ctx, c)
}

// route picks the handler of an update and sets c.Args for commands.
func (r *Router) route(ctx context.Context, kind UpdateKind, c *Context) (Handler, error) {
	u := c.Update
	switch kind {
	case UpdateKindMessage:
		name, args, mention, ok := parseCommand(u.Message)
		if ok {
			if fn := r.commands[name]; fn != nil {
				matches := true
				if mention != "" {
					username, err := r.botUsername(ctx)
					if err != nil {
						return nil, err
					}
					matches = strings.EqualFold(mention, username)
				}
				if matches {
					c.Args = args
					return fn, nil
				}
			}
		}
		if r.message != nil {
			return r.message, nil
		}
	case UpdateKindCallback:
		for _, route := range r.callbacks {
			if strings.HasPrefix(u.Callback.Data, route.prefix) {
				return route.fn, nil
			}
		}
	case UpdateKindInlineQuery:
		if r.inline != nil {
			return r.inline, nil
		}
	}
	return r.kinds[kind], nil
}

// botUsername returns the bot's username, read with GetMe once (a failed read
// is tried again on the next command).
func (r *Router) botUsername(ctx context.Context) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.known {
		return r.username, nil
	}
	me, err := r.client.GetMe(ctx)
	if err != nil {
		return "", err
	}
	r.username, r.known = me.Username, true
	return r.username, nil
}

// parseCommand reads a bot_command entity at offset 0: the lowercase name
// without "/", the args after it (trimmed) and the "@username" part.
func parseCommand(m *Message) (name, args, mention string, ok bool) {
	for _, e := range m.Entities {
		if e.Type != EntityTypeBotCommand || e.Offset != 0 || e.Length <= 1 {
			continue
		}
		units := utf16.Encode([]rune(m.Text))
		if int(e.Length) > len(units) {
			return "", "", "", false
		}
		command := string(utf16.Decode(units[:e.Length]))
		rest := string(utf16.Decode(units[e.Length:]))
		if !strings.HasPrefix(command, "/") {
			return "", "", "", false
		}
		name, mention, _ = strings.Cut(command[1:], "@")
		return strings.ToLower(name), strings.TrimSpace(rest), mention, true
	}
	return "", "", "", false
}

// updateKind names the kind an update carries, "" for an unknown kind.
func updateKind(u Update) UpdateKind {
	switch {
	case u.Message != nil:
		return UpdateKindMessage
	case u.MessageEdited != nil:
		return UpdateKindMessageEdited
	case u.ChannelPost != nil:
		return UpdateKindChannelPost
	case u.Callback != nil:
		return UpdateKindCallback
	case u.MemberChanged != nil:
		return UpdateKindMemberChanged
	case u.Reaction != nil:
		return UpdateKindReaction
	case u.InlineQuery != nil:
		return UpdateKindInlineQuery
	}
	return ""
}
