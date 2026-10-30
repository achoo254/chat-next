package chatmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/rpc"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// instructions tell the client how the tools fit together.
const instructions = `Tools act as the signed-in user of this chat, with exactly the rights the user has in the app.
Chats are identified by chat_id and messages by (chat_id, seq); users and bots by their user id.
Start with list_chats or search_messages, read with get_messages, find people with search_users or resolve_username, then send_message (start_private_chat opens a one-to-one chat).
Messages: forward_messages, copy_message, pin_message, get_pinned_messages, get_message_reactions, get_message_readers.
Groups and channels: create_group, create_channel, add_members, update_chat_info, export_invite_link, get_forum_topics, create_forum_topic, set_admin; set_dialog_mute, set_dialog_pinned and set_dialog_unread_mark change only the user's own chat list.
Contacts: get_contacts, add_contact, block_user, get_common_chats. Incoming webhooks of chats the user administers: list_incoming_hooks, get_incoming_hook_stats, list_incoming_hook_dead_letters, get_incoming_hook_audit.
Bots: list_bots, get_bot_delivery (webhook and delivery state), list_bot_dead_letters.
Tools that say "two calls" (bot webhook, token and deletion, which also need bots:admin; incoming webhook creation, secret rotation, take-over and deletion) work like this:
the first returns a preview and a confirm_token; show the preview to the user, and only after the user agrees call the tool again with the same arguments plus confirm_token.`

// toolDef is one tool: its name, the scope it needs and how it is added
// to a server built for one request.
type toolDef struct {
	name  string
	scope string
	add   func(s *mcp.Server, t *toolset)
}

func allTools() []toolDef {
	var all []toolDef
	for _, group := range [][]toolDef{chatTools(), messageTools(), groupTools(), contactTools(), hookTools(), botTools()} {
		all = append(all, group...)
	}
	return all
}

// confirmNote marks the tools that run in two calls (see confirmed).
const confirmNote = " Runs in two calls: the first returns a preview and a confirm_token, the second (same arguments plus confirm_token, after the user agreed) does it."

// toolset is what the tools of one request share.
type toolset struct {
	h *Handler
	c caller
}

// newServer builds the MCP server of one request for caller c (stateless
// transport: one server per HTTP request, schemas cached across them).
func (h *Handler) newServer(c caller) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "chat", Title: h.cfg.ResourceName, Version: "1.0.0"}, &mcp.ServerOptions{
		Instructions: instructions,
		SchemaCache:  h.schemas,
		Capabilities: &mcp.ServerCapabilities{},
	})
	t := &toolset{h: h, c: c}
	for _, def := range allTools() {
		def.add(s, t)
	}
	return s
}

// errNoChatAccount: the IdP account has no chat account yet.
var errNoChatAccount = connect.NewError(connect.CodeFailedPrecondition,
	errors.New("chat_account_required: sign in to the chat app once to create your chat account, then retry"))

// call runs a service handler method as the caller.
func call[Req, Resp any](ctx context.Context, t *toolset,
	method func(context.Context, *connect.Request[Req]) (*connect.Response[Resp], error), msg *Req,
) (*Resp, error) {
	return callAs(ctx, t, false, method, msg)
}

// callAs is call; approved marks a confirmed bots:admin call (it stands in
// for the recent IdP sign-in those changes need in the app).
func callAs[Req, Resp any](ctx context.Context, t *toolset, approved bool,
	method func(context.Context, *connect.Request[Req]) (*connect.Response[Resp], error), msg *Req,
) (*Resp, error) {
	sess, err := t.c.session(t.h.cfg.TenantID, approved)
	if err != nil {
		return nil, err
	}
	return rpc.Invoke(ctx, sess, method, msg)
}

// callSelf runs UsersService.GetSelf, which /rpc also serves to an account
// waiting for deletion (lockedProcedures): it carries the deletion date.
func callSelf(ctx context.Context, t *toolset) (*appv1.GetSelfResponse, error) {
	sess, err := t.c.session(t.h.cfg.TenantID, false)
	if err != nil {
		return nil, err
	}
	sess.AccountLocked = false
	return rpc.Invoke(ctx, sess, t.h.cfg.Services.Users.GetSelf, &appv1.GetSelfRequest{})
}

// addTool registers a tool whose run returns a protobuf message or a plain
// value; both become structured content (and its JSON text). A failure
// becomes a tool error {"error":{"code","message"}} the model can read.
//
// The handler checks the tool's scope itself: this is the authoritative
// check (the HTTP step-up check only lets the client ask for the scope).
// A tool missing from allTools has no scope and is refused.
func addTool[In any](s *mcp.Server, t *toolset, tool *mcp.Tool, run func(context.Context, In) (any, error)) {
	scope, known := t.h.toolScopes[tool.Name]
	mcp.AddTool(s, tool, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		if !known || !t.c.token.HasScope(scope) {
			return t.errorResult(ctx, tool.Name, connect.NewError(connect.CodePermissionDenied,
				fmt.Errorf("insufficient_scope: tool %s needs the %s scope", tool.Name, scope))), nil, nil
		}
		out, err := run(ctx, in)
		if err != nil {
			return t.errorResult(ctx, tool.Name, err), nil, nil
		}
		raw, err := encode(out)
		if err != nil {
			return t.errorResult(ctx, tool.Name, err), nil, nil
		}
		return nil, raw, nil
	})
}

var protoJSON = protojson.MarshalOptions{UseProtoNames: true}

func encode(v any) (json.RawMessage, error) {
	m, ok := v.(proto.Message)
	if !ok {
		return json.Marshal(v)
	}
	raw, err := protoJSON.Marshal(m)
	if err != nil {
		return nil, err
	}
	// protojson writes 64-bit integers as strings; every id fits 2^53 (ADR
	// 0001, checked by rpc.Invoke), so they go out as numbers, the way the
	// tools take them back.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, err
	}
	numberize(m.ProtoReflect().Descriptor(), tree)
	return json.Marshal(tree)
}

// numberize turns the 64-bit integer fields of the protojson object v of a
// message md into JSON numbers, in nested messages, lists and map values.
func numberize(md protoreflect.MessageDescriptor, v any) {
	obj, ok := v.(map[string]any)
	if !ok {
		return
	}
	for name, val := range obj {
		fd := md.Fields().ByName(protoreflect.Name(name))
		switch {
		case fd == nil:
		case fd.IsMap():
			if m, ok := val.(map[string]any); ok {
				for k, x := range m {
					m[k] = numberValue(fd.MapValue(), x)
				}
			}
		case fd.IsList():
			if list, ok := val.([]any); ok {
				for i, x := range list {
					list[i] = numberValue(fd, x)
				}
			}
		default:
			obj[name] = numberValue(fd, val)
		}
	}
}

func numberValue(fd protoreflect.FieldDescriptor, v any) any {
	switch fd.Kind() {
	case protoreflect.MessageKind, protoreflect.GroupKind:
		numberize(fd.Message(), v)
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind,
		protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		if s, ok := v.(string); ok {
			return json.Number(s)
		}
	}
	return v
}

// errorResult maps err like /rpc: connect errors keep their code and
// message, anything else is logged and becomes an opaque internal error.
func (t *toolset) errorResult(ctx context.Context, tool string, err error) *mcp.CallToolResult {
	code, message := "internal", "internal error"
	var ce *connect.Error
	if errors.As(err, &ce) {
		code, message = ce.Code().String(), ce.Message()
	} else {
		t.h.cfg.Logger.ErrorContext(ctx, "MCP tool failed", "tool", tool, "err", err)
	}
	var body httpError
	body.Error.Code, body.Error.Message = code, message
	text, _ := json.Marshal(body)
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(text)}}}
}

// preview is the first answer of a two-call tool.
type preview struct {
	Preview               any    `json:"preview"`
	ConfirmToken          string `json:"confirm_token"`
	ConfirmTokenExpiresAt string `json:"confirm_token_expires_at"`
	Next                  string `json:"next"`
}

// confirmed runs the two-call flow of a tool that hands out a secret,
// redirects updates or destroys something (the bots:admin tools, and the
// incoming webhook tools that return a secret URL, take a hook over or
// stop a URL). Without a token it answers describe()'s preview and a token
// bound to (user, tool, args); with one it spends the token and runs do
// (the bots:admin tools run it as an approved call). args must be the
// input without its confirm_token.
func confirmed(t *toolset, tool string, args any, token string,
	describe func() (any, error), do func() (any, error),
) (any, error) {
	if token == "" {
		p, err := describe()
		if err != nil {
			return nil, err
		}
		tok, expires, err := t.h.confirm.issue(t.c.token.Subject, tool, args)
		if err != nil {
			return nil, err
		}
		return preview{
			Preview: p, ConfirmToken: tok, ConfirmTokenExpiresAt: expires.UTC().Format(time.RFC3339),
			Next: "Nothing changed yet. Show this preview to the user; only if they agree, call " + tool +
				" again with the same arguments and this confirm_token (valid 5 minutes, once).",
		}, nil
	}
	if err := t.h.confirm.consume(token, t.c.token.Subject, tool, args); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return do()
}

func ptr[T any](v T) *T { return &v }
