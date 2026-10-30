package chatmcp

import (
	"context"
	"errors"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type botInput struct {
	BotID int64 `json:"bot_id" jsonschema:"the bot (its user id, from list_bots)"`
}

type createBotInput struct {
	Username string `json:"username" jsonschema:"5 to 32 characters of a-z, 0-9 and _ ending in bot"`
	Name     string `json:"name" jsonschema:"display name, 1 to 64 characters"`
}

type botCommand struct {
	Command     string `json:"command" jsonschema:"1 to 32 characters of a-z, 0-9 and _, without the slash"`
	Description string `json:"description" jsonschema:"1 to 256 characters"`
}

type updateBotInput struct {
	BotID             int64        `json:"bot_id" jsonschema:"the bot"`
	Name              *string      `json:"name,omitempty" jsonschema:"display name"`
	Description       *string      `json:"description,omitempty" jsonschema:"shown in the empty chat before a user starts the bot; up to 512 characters"`
	About             *string      `json:"about,omitempty" jsonschema:"profile text; up to 120 characters"`
	Privacy           *bool        `json:"privacy,omitempty" jsonschema:"privacy mode: in groups the bot only gets commands and replies to it"`
	InlinePlaceholder *string      `json:"inline_placeholder,omitempty" jsonschema:"turns inline mode on with this hint; empty turns it off"`
	MiniAppURL        *string      `json:"mini_app_url,omitempty" jsonschema:"https URL of the bot's Mini App; empty removes it"`
	Commands          []botCommand `json:"commands,omitempty" jsonschema:"replaces the bot's command menu (for every chat); send an empty list with replace_commands to remove all"`
	ReplaceCommands   bool         `json:"replace_commands,omitempty" jsonschema:"set to replace the command menu with commands (even when empty)"`
}

type updateIDsInput struct {
	BotID     int64   `json:"bot_id" jsonschema:"the bot"`
	UpdateIDs []int64 `json:"update_ids" jsonschema:"1 to 100 update ids from list_bot_dead_letters"`
}

type setWebhookInput struct {
	BotID          int64    `json:"bot_id" jsonschema:"the bot"`
	URL            string   `json:"url" jsonschema:"https URL on port 443, 80 or 8443 resolving to public addresses"`
	Secret         string   `json:"secret,omitempty" jsonschema:"1 to 256 characters of A-Z a-z 0-9 _ -, sent in X-Bot-Api-Secret-Token and keying X-Bot-Signature; required for a new URL"`
	AllowedUpdates []string `json:"allowed_updates,omitempty" jsonschema:"update kinds to deliver; empty for the default"`
	MaxConnections int32    `json:"max_connections,omitempty" jsonschema:"1 to 100 parallel deliveries; 0 means 40"`
	DropPending    bool     `json:"drop_pending,omitempty" jsonschema:"drop the pending updates instead of delivering them"`
	ConfirmToken   string   `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

type deleteWebhookInput struct {
	BotID        int64  `json:"bot_id" jsonschema:"the bot"`
	DropPending  bool   `json:"drop_pending,omitempty" jsonschema:"drop the pending updates instead of keeping them for long poll"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

type confirmBotInput struct {
	BotID        int64  `json:"bot_id" jsonschema:"the bot"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"from the preview; omit to get the preview"`
}

// adminNote marks the tools that need bots:admin and a confirm token.
const adminNote = " Needs bots:admin." + confirmNote

// ownedBot finds bot_id among the caller's bots (NotFound otherwise).
func ownedBot(ctx context.Context, t *toolset, botID int64) (*appv1.Bot, error) {
	resp, err := call(ctx, t, t.h.cfg.Services.BotAdmin.ListMyBots, &appv1.ListMyBotsRequest{})
	if err != nil {
		return nil, err
	}
	for _, b := range resp.GetBots() {
		if b.GetUser().GetId() == botID {
			return b, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
}

// botSummary is how a preview names the bot.
type botSummary struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Name     string `json:"name"`
}

func summarize(b *appv1.Bot) botSummary {
	return botSummary{ID: b.GetUser().GetId(), Username: b.GetUser().GetUsername(), Name: b.GetUser().GetName()}
}

// currentWebhook returns the bot's webhook URL ("" for long poll); it also
// checks that the caller owns the bot.
func currentWebhook(ctx context.Context, t *toolset, botID int64) (string, error) {
	d, err := call(ctx, t, t.h.cfg.Services.BotAdmin.GetBotDelivery, &appv1.GetBotDeliveryRequest{BotId: botID})
	if err != nil {
		return "", err
	}
	return d.GetWebhook().GetUrl(), nil
}

func botTools() []toolDef {
	admin := func(name, description string) *mcp.Tool {
		return &mcp.Tool{Name: name, Description: description + adminNote, Annotations: destructive}
	}
	return []toolDef{
		{"list_bots", ScopeBotsRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "list_bots", Description: "The bots the user owns, with their settings, commands and whether they use a webhook.", Annotations: readOnly},
				func(ctx context.Context, _ noInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.ListMyBots, &appv1.ListMyBotsRequest{})
				})
		}},
		{"get_bot_delivery", ScopeBotsRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "get_bot_delivery", Description: "How a bot receives updates: its webhook (URL, update kinds, connections), pending and failed deliveries, last error and counters.", Annotations: readOnly},
				func(ctx context.Context, in botInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.GetBotDelivery, &appv1.GetBotDeliveryRequest{BotId: in.BotID})
				})
		}},
		{"list_bot_dead_letters", ScopeBotsRead, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "list_bot_dead_letters", Description: "Updates the bot's webhook failed to take after every retry (newest 100).", Annotations: readOnly},
				func(ctx context.Context, in botInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.ListBotDeadLetters, &appv1.ListBotDeadLettersRequest{BotId: in.BotID})
				})
		}},
		{"create_bot", ScopeBotsWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "create_bot", Description: "Create a bot owned by the user. It has no token until reset_bot_token issues one.", Annotations: additive},
				func(ctx context.Context, in createBotInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.CreateBot, &appv1.CreateBotRequest{Username: in.Username, Name: in.Name})
				})
		}},
		{"update_bot", ScopeBotsWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "update_bot", Description: "Change a bot's profile, privacy mode, inline mode, Mini App or command menu; omitted fields stay.", Annotations: destructive},
				func(ctx context.Context, in updateBotInput) (any, error) {
					req := &appv1.UpdateBotRequest{
						BotId: in.BotID, Name: in.Name, Description: in.Description, About: in.About, Privacy: in.Privacy,
						InlinePlaceholder: in.InlinePlaceholder, MiniAppUrl: in.MiniAppURL,
					}
					if in.ReplaceCommands || len(in.Commands) > 0 {
						req.Commands = &appv1.BotCommandSets{}
						if len(in.Commands) > 0 {
							set := &appv1.BotCommandSet{Scope: appv1.BotCommandScope_BOT_COMMAND_SCOPE_DEFAULT}
							for _, c := range in.Commands {
								set.Commands = append(set.Commands, &appv1.BotCommand{Command: c.Command, Description: c.Description})
							}
							req.Commands.Sets = []*appv1.BotCommandSet{set}
						}
					}
					return call(ctx, t, t.h.cfg.Services.BotAdmin.UpdateBot, req)
				})
		}},
		{"retry_bot_dead_letters", ScopeBotsWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "retry_bot_dead_letters", Description: "Deliver failed updates to the bot's webhook again.", Annotations: additive},
				func(ctx context.Context, in updateIDsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.RetryBotDeadLetters, &appv1.RetryBotDeadLettersRequest{BotId: in.BotID, UpdateIds: in.UpdateIDs})
				})
		}},
		{"discard_bot_dead_letters", ScopeBotsWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "discard_bot_dead_letters", Description: "Drop failed updates for good.", Annotations: destructive},
				func(ctx context.Context, in updateIDsInput) (any, error) {
					return call(ctx, t, t.h.cfg.Services.BotAdmin.DiscardBotDeadLetters, &appv1.DiscardBotDeadLettersRequest{BotId: in.BotID, UpdateIds: in.UpdateIDs})
				})
		}},
		{"set_bot_webhook", ScopeBotsAdmin, func(s *mcp.Server, t *toolset) {
			addTool(s, t, admin("set_bot_webhook", "Send the bot's updates to a webhook URL. That URL receives every message sent to the bot and can answer as the bot."),
				func(ctx context.Context, in setWebhookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "set_bot_webhook", args, in.ConfirmToken, func() (any, error) {
						bot, err := ownedBot(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						current, err := currentWebhook(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						return map[string]any{
							"action": "set the bot's webhook", "bot": summarize(bot), "current_webhook_url": current, "new_webhook_url": in.URL,
							"allowed_updates": in.AllowedUpdates, "drop_pending": in.DropPending,
							"effect": "every update of the bot goes to the new URL, which can also answer as the bot",
						}, nil
					}, func() (any, error) {
						return callAs(ctx, t, true, t.h.cfg.Services.BotAdmin.SetBotWebhook, &appv1.SetBotWebhookRequest{
							BotId: in.BotID, Url: in.URL, Secret: in.Secret, AllowedUpdates: in.AllowedUpdates,
							MaxConnections: in.MaxConnections, DropPending: in.DropPending,
						})
					})
				})
		}},
		{"delete_bot_webhook", ScopeBotsAdmin, func(s *mcp.Server, t *toolset) {
			addTool(s, t, admin("delete_bot_webhook", "Stop the bot's webhook; the bot then fetches its updates by long poll."),
				func(ctx context.Context, in deleteWebhookInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "delete_bot_webhook", args, in.ConfirmToken, func() (any, error) {
						bot, err := ownedBot(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						current, err := currentWebhook(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						return map[string]any{
							"action": "remove the bot's webhook", "bot": summarize(bot), "current_webhook_url": current, "drop_pending": in.DropPending,
						}, nil
					}, func() (any, error) {
						return callAs(ctx, t, true, t.h.cfg.Services.BotAdmin.DeleteBotWebhook, &appv1.DeleteBotWebhookRequest{BotId: in.BotID, DropPending: in.DropPending})
					})
				})
		}},
		{"reset_bot_token", ScopeBotsAdmin, func(s *mcp.Server, t *toolset) {
			addTool(s, t, admin("reset_bot_token", "Issue a new token for the bot and return it once; the old token stops working and the webhook is removed."),
				func(ctx context.Context, in confirmBotInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "reset_bot_token", args, in.ConfirmToken, func() (any, error) {
						bot, err := ownedBot(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						return map[string]any{
							"action": "issue a new bot token", "bot": summarize(bot), "has_token": bot.GetHasToken(), "webhook": bot.GetWebhook(),
							"effect": "the old token stops working at once and any webhook is removed; the new token is shown in the answer",
						}, nil
					}, func() (any, error) {
						return callAs(ctx, t, true, t.h.cfg.Services.BotAdmin.ResetBotToken, &appv1.ResetBotTokenRequest{BotId: in.BotID})
					})
				})
		}},
		{"delete_bot", ScopeBotsAdmin, func(s *mcp.Server, t *toolset) {
			addTool(s, t, admin("delete_bot", "Delete the bot for good: its token, webhook and username go away."),
				func(ctx context.Context, in confirmBotInput) (any, error) {
					args := in
					args.ConfirmToken = ""
					return confirmed(t, "delete_bot", args, in.ConfirmToken, func() (any, error) {
						bot, err := ownedBot(ctx, t, in.BotID)
						if err != nil {
							return nil, err
						}
						return map[string]any{"action": "delete the bot", "bot": summarize(bot), "effect": "cannot be undone"}, nil
					}, func() (any, error) {
						if _, err := callAs(ctx, t, true, t.h.cfg.Services.BotAdmin.DeleteBot, &appv1.DeleteBotRequest{BotId: in.BotID}); err != nil {
							return nil, err
						}
						return map[string]any{"deleted": true, "bot_id": in.BotID}, nil
					})
				})
		}},
	}
}
