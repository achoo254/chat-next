package chatmcp

import (
	"context"
	"errors"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// hookFormats maps the format argument of create_incoming_hook.
var hookFormats = map[string]appv1.IncomingHookFormat{
	"":             appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE,
	"native":       appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE,
	"slack":        appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK,
	"alertmanager": appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER,
	"grafana":      appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GRAFANA,
	"gitlab":       appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GITLAB,
}

type hookInput struct {
	HookID string `json:"hook_id" jsonschema:"the hook (hk_..., from list_incoming_hooks)"`
}

type createHookInput struct {
	ChatID       int64  `json:"chat_id" jsonschema:"the group or channel the hook posts in (the user must be an admin)"`
	Name         string `json:"name" jsonschema:"1 to 64 characters, shown as the integration label of its messages"`
	Format       string `json:"format,omitempty" jsonschema:"payload format: native (default), slack, alertmanager, grafana or gitlab"`
	AllowAlert   bool   `json:"allow_alert,omitempty" jsonschema:"let payloads ask for alert priority"`
	Silent       bool   `json:"silent,omitempty" jsonschema:"post every message without a notification"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

type updateHookInput struct {
	HookID     string  `json:"hook_id" jsonschema:"the hook"`
	Name       *string `json:"name,omitempty" jsonschema:"new name, 1 to 64 characters; omit to keep"`
	AllowAlert *bool   `json:"allow_alert,omitempty" jsonschema:"omit to keep"`
	Silent     *bool   `json:"silent,omitempty" jsonschema:"omit to keep"`
}

type hookEnabledInput struct {
	HookID  string `json:"hook_id" jsonschema:"the hook"`
	Enabled bool   `json:"enabled" jsonschema:"true turns the hook on (its creator must still be an admin); false turns it off"`
}

type hookStatsInput struct {
	HookID string `json:"hook_id" jsonschema:"the hook"`
	Hours  int32  `json:"hours,omitempty" jsonschema:"window in hours, 1 to 720; 0 means 24"`
}

type hookDeadLettersInput struct {
	HookID   string `json:"hook_id" jsonschema:"the hook"`
	BeforeID int64  `json:"before_id,omitempty" jsonschema:"entries below this id; 0 for the newest"`
	Limit    int32  `json:"limit,omitempty" jsonschema:"1 to 100; 0 means 50"`
}

type hookAuditInput struct {
	ChatID   int64  `json:"chat_id" jsonschema:"the group or channel"`
	HookID   string `json:"hook_id,omitempty" jsonschema:"only this hook; empty for every hook of the chat"`
	BeforeID int64  `json:"before_id,omitempty" jsonschema:"entries below this id; 0 for the newest"`
	Limit    int32  `json:"limit,omitempty" jsonschema:"1 to 100; 0 means 50"`
}

type rotateHookInput struct {
	HookID         string `json:"hook_id" jsonschema:"the hook"`
	RevokePrevious bool   `json:"revoke_previous,omitempty" jsonschema:"the current URL stops at once instead of after 7 days"`
	ConfirmToken   string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

type confirmHookInput struct {
	HookID       string `json:"hook_id" jsonschema:"the hook"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

type takeOverHookInput struct {
	HookID       string `json:"hook_id" jsonschema:"the hook"`
	RotateSecret bool   `json:"rotate_secret,omitempty" jsonschema:"also issue a new URL (the old one stops at once); off keeps the URL working"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

// hookSummary is how a preview names the hook (never its secret).
type hookSummary struct {
	ID        string `json:"id"`
	ChatID    int64  `json:"chat_id"`
	Name      string `json:"name"`
	Format    string `json:"format"`
	State     string `json:"state"`
	CreatedBy int64  `json:"created_by"`
}

// currentHook reads the hook; the service answers it only to an admin of
// the hook's chat.
func currentHook(ctx context.Context, t *toolset, hookID string) (*appv1.IncomingHook, error) {
	resp, err := call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHook, &appv1.GetIncomingHookRequest{HookId: hookID})
	if err != nil {
		return nil, err
	}
	return resp.GetHook(), nil
}

func summarizeHook(h *appv1.IncomingHook) hookSummary {
	return hookSummary{
		ID: h.GetId(), ChatID: h.GetChatId(), Name: h.GetName(), Format: h.GetFormat().String(),
		State: h.GetState().String(), CreatedBy: h.GetCreatedBy(),
	}
}

// hookPreview describes a confirmed change of an existing hook.
func hookPreview(ctx context.Context, t *toolset, hookID string, fields map[string]any) (any, error) {
	h, err := currentHook(ctx, t, hookID)
	if err != nil {
		return nil, err
	}
	fields["hook"] = summarizeHook(h)
	return fields, nil
}

// hookTools manage a chat's incoming webhooks, as its admins do in the app.
// Calls that hand out a secret URL, change who owns a hook or stop a URL
// go through a preview and confirm_token, like the bots:admin tools.
func hookTools() []toolDef {
	confirm := func(name, description string, ann *mcp.ToolAnnotations) *mcp.Tool {
		return &mcp.Tool{Name: name, Description: description + confirmNote, Annotations: ann}
	}
	return []toolDef{
		{"list_incoming_hooks", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "list_incoming_hooks", Description: "Incoming webhooks of a group or channel the user administers, with their state and creators (never their secret URL).", Annotations: readOnly},
				func(ctx context.Context, in chatInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHooks, &appv1.GetIncomingHooksRequest{ChatId: in.ChatID})
				})
		}},
		{"get_incoming_hook", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_incoming_hook", Description: "One incoming webhook (without its secret URL).", Annotations: readOnly},
				func(ctx context.Context, in hookInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHook, &appv1.GetIncomingHookRequest{HookId: in.HookID})
				})
		}},
		{"get_incoming_hook_stats", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_incoming_hook_stats", Description: "Accepted, delivered and failed requests of a hook over the last hours, failures by reason.", Annotations: readOnly},
				func(ctx context.Context, in hookStatsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHookStats, &appv1.GetIncomingHookStatsRequest{HookId: in.HookID, Hours: in.Hours})
				})
		}},
		{"list_incoming_hook_dead_letters", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "list_incoming_hook_dead_letters", Description: "Requests a hook could not process (kept 30 days), newest first, with the reason and the body received (base64).", Annotations: readOnly},
				func(ctx context.Context, in hookDeadLettersInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHookDeadLetters, &appv1.GetIncomingHookDeadLettersRequest{
						HookId: in.HookID, BeforeId: in.BeforeID, Limit: in.Limit,
					})
				})
		}},
		{"get_incoming_hook_audit", ScopeChatRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_incoming_hook_audit", Description: "Audit log of a chat's hooks (deleted ones included), newest first.", Annotations: readOnly},
				func(ctx context.Context, in hookAuditInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHookAudit, &appv1.GetIncomingHookAuditRequest{
						ChatId: in.ChatID, HookId: in.HookID, BeforeId: in.BeforeID, Limit: in.Limit,
					})
				})
		}},
		{"update_incoming_hook", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "update_incoming_hook", Description: "Change a hook's name, allow_alert or silent; omitted fields stay. The format is fixed by its URL.", Annotations: destructive},
				func(ctx context.Context, in updateHookInput) (any, error) {
					h, err := currentHook(ctx, t, in.HookID)
					if err != nil {
						return nil, err
					}
					req := &appv1.UpdateIncomingHookRequest{HookId: in.HookID, Name: h.GetName(), AllowAlert: h.GetAllowAlert(), Silent: h.GetSilent()}
					if in.Name != nil {
						req.Name = *in.Name
					}
					if in.AllowAlert != nil {
						req.AllowAlert = *in.AllowAlert
					}
					if in.Silent != nil {
						req.Silent = *in.Silent
					}
					return call(ctx, t, t.h.cfg.Services.Integrations.UpdateIncomingHook, req)
				})
		}},
		{"set_incoming_hook_enabled", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "set_incoming_hook_enabled", Description: "Turn a hook off (its requests are refused) or back on.", Annotations: idempotent},
				func(ctx context.Context, in hookEnabledInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.Integrations.SetIncomingHookEnabled, &appv1.SetIncomingHookEnabledRequest{HookId: in.HookID, Enabled: in.Enabled})
				})
		}},
		{"create_incoming_hook", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, confirm("create_incoming_hook", "Create an incoming webhook in a group or channel the user administers and return its secret URL once; anyone holding the URL can post into the chat.", additive),
				func(ctx context.Context, in createHookInput) (any, error) {
					format, ok := hookFormats[in.Format]
					if !ok {
						return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("format must be native, slack, alertmanager, grafana or gitlab"))
					}
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "create_incoming_hook", args, in.ConfirmToken, func() (any, error) {
						hooks, err := call(ctx, t, t.h.cfg.Services.Integrations.GetIncomingHooks, &appv1.GetIncomingHooksRequest{ChatId: in.ChatID})
						if err != nil {
							return nil, err
						}
						chat, err := call(ctx, t, t.h.cfg.Services.Chats.GetChat, &appv1.GetChatRequest{ChatId: in.ChatID})
						if err != nil {
							return nil, err
						}
						return map[string]any{
							"action": "create an incoming webhook", "chat_id": in.ChatID, "chat_title": chat.GetChat().GetTitle(),
							"existing_hooks": len(hooks.GetHooks()), "name": in.Name, "format": format.String(),
							"allow_alert": in.AllowAlert, "silent": in.Silent,
							"effect": "the answer carries a secret URL, shown once; anyone holding it can post into the chat as this integration",
						}, nil
					}, func() (any, error) {
						return call(ctx, t, t.h.cfg.Services.Integrations.CreateIncomingHook, &appv1.CreateIncomingHookRequest{
							ChatId: in.ChatID, Name: in.Name, Format: format, AllowAlert: in.AllowAlert, Silent: in.Silent,
						})
					})
				})
		}},
		{"rotate_incoming_hook_secret", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, confirm("rotate_incoming_hook_secret", "Issue a new secret URL for a hook and return it once. The current URL keeps working 7 days unless revoke_previous.", destructive),
				func(ctx context.Context, in rotateHookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "rotate_incoming_hook_secret", args, in.ConfirmToken, func() (any, error) {
						effect := "a new secret URL is returned once; the current URL keeps working for 7 days"
						if in.RevokePrevious {
							effect = "a new secret URL is returned once; the current URL stops at once, so tools still using it fail"
						}
						return hookPreview(ctx, t, in.HookID, map[string]any{"action": "rotate the hook's secret URL", "effect": effect})
					}, func() (any, error) {
						return call(ctx, t, t.h.cfg.Services.Integrations.RotateIncomingHookSecret, &appv1.RotateIncomingHookSecretRequest{
							HookId: in.HookID, RevokePrevious: in.RevokePrevious,
						})
					})
				})
		}},
		{"revoke_previous_hook_secret", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, confirm("revoke_previous_hook_secret", "End the 7-day grace period of a hook's previous URL now (for a leaked URL).", destructive),
				func(ctx context.Context, in confirmHookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "revoke_previous_hook_secret", args, in.ConfirmToken, func() (any, error) {
						return hookPreview(ctx, t, in.HookID, map[string]any{
							"action": "revoke the hook's previous secret URL",
							"effect": "tools still posting to the previous URL fail from now on",
						})
					}, func() (any, error) {
						return call(ctx, t, t.h.cfg.Services.Integrations.RevokePreviousHookSecret, &appv1.RevokePreviousHookSecretRequest{HookId: in.HookID})
					})
				})
		}},
		{"take_over_incoming_hook", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, confirm("take_over_incoming_hook", "Make the user the creator of a hook and turn it on (for a hook whose creator is no longer an admin); with rotate_secret a new URL is returned once.", destructive),
				func(ctx context.Context, in takeOverHookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "take_over_incoming_hook", args, in.ConfirmToken, func() (any, error) {
						effect := "the user becomes the hook's creator and it is turned on with the same URL"
						if in.RotateSecret {
							effect = "the user becomes the hook's creator and it is turned on; a new secret URL is returned once and the old URL stops at once"
						}
						return hookPreview(ctx, t, in.HookID, map[string]any{"action": "take over the hook", "effect": effect})
					}, func() (any, error) {
						return call(ctx, t, t.h.cfg.Services.Integrations.TakeOverIncomingHook, &appv1.TakeOverIncomingHookRequest{
							HookId: in.HookID, RotateSecret: in.RotateSecret,
						})
					})
				})
		}},
		{"delete_incoming_hook", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, confirm("delete_incoming_hook", "Delete a hook for good: its URL stops working.", destructive),
				func(ctx context.Context, in confirmHookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "delete_incoming_hook", args, in.ConfirmToken, func() (any, error) {
						return hookPreview(ctx, t, in.HookID, map[string]any{
							"action": "delete the hook", "effect": "its URL stops working; cannot be undone",
						})
					}, func() (any, error) {
						if _, err := call(ctx, t, t.h.cfg.Services.Integrations.DeleteIncomingHook, &appv1.DeleteIncomingHookRequest{HookId: in.HookID}); err != nil {
							return nil, err
						}
						return map[string]any{"deleted": true, "hook_id": in.HookID}, nil
					})
				})
		}},
	}
}
