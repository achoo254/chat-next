package chat

import (
	"context"
	"fmt"
	"strings"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Bot API methods that need more than the user paths give. Every other
// method of the Bot API (delete, forward, copy, reactions, pins, media,
// group administration) calls the user path with the bot as me on an
// AsBot context, so the same rules apply to bots and people.

// Member statuses as the Bot API shows them.
const (
	MemberStatusOwner  = "owner"
	MemberStatusAdmin  = "admin"
	MemberStatusMember = "member"
	MemberStatusLeft   = "left"
	MemberStatusBanned = "banned"
)

// BotEdit changes a message the bot sent.
type BotEdit struct {
	ChatID, Seq int64
	// Text, when not nil, replaces the text (the caption of a media message)
	// and its entities; nil keeps both and edits the keyboard only.
	Text          *string
	Entities      []*appv1.MessageEntity
	NoLinkPreview bool
	// SetMarkup replaces the inline keyboard with Markup (nil removes it);
	// without it the keyboard stays.
	SetMarkup bool
	Markup    *appv1.ReplyMarkup
}

// EditBotMessage edits a message of the bot: its text and entities (an
// edit: edit_date is set) and/or its inline keyboard (a keyboard change
// alone is not marked edited). Bots edit their messages at any age, as
// long as they may still send in the chat; reply keyboards cannot be
// edited, only replaced by a new message.
func (s *Service) EditBotMessage(ctx context.Context, botID int64, e BotEdit) (*appv1.Message, error) {
	if e.Text == nil && !e.SetMarkup {
		return nil, errInvalid("nothing to edit")
	}
	var text string
	var ents []*appv1.MessageEntity
	if e.Text != nil {
		var err error
		if text, ents, err = s.validateText(*e.Text, e.Entities, true); err != nil {
			return nil, err
		}
		if err := s.checkMentions(ctx, botID, ents); err != nil {
			return nil, err
		}
	}
	if e.SetMarkup && e.Markup != nil {
		if e.Markup.GetInlineKeyboard() == nil {
			return nil, errInvalid("only an inline keyboard can be set on a sent message")
		}
		if err := s.validateBotMarkup(ctx, e.Markup); err != nil {
			return nil, err
		}
	}
	ok, err := s.liveBot(ctx, s.pool, botID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errDenied("the bot is deleted")
	}
	url := ""
	if e.Text != nil && !e.NoLinkPreview {
		url = s.previewURL(text, ents)
	}
	preview, fetchLater := s.cachedPreview(ctx, url)
	var edited *messageRow
	_, err = s.inTx(ctx, func(t *txn) error {
		edited = nil
		c, mem, err := s.activeChatFor(ctx, t.tx, e.ChatID, botID, true)
		if err != nil {
			return err
		}
		m, err := s.liveMessage(ctx, t.tx, e.ChatID, e.Seq)
		if err != nil {
			return err
		}
		if m.FromID != botID {
			return errDenied("a bot can only edit its own messages")
		}
		if !c.can(mem, permSend) {
			return errDenied("the bot cannot send messages in this chat")
		}
		content := &appv1.Message{}
		if len(m.Content) > 0 {
			if err := proto.Unmarshal(m.Content, content); err != nil {
				return fmt.Errorf("chat: decode message: %w", err)
			}
		}
		if content.GetAction() != nil {
			return errInvalid("service messages cannot be edited")
		}
		if e.SetMarkup && content.GetReplyMarkup() != nil && content.GetReplyMarkup().GetInlineKeyboard() == nil {
			return errInvalid("the message carries a reply keyboard, which cannot be edited")
		}
		newText, markEdited := m.Text, false
		if e.Text != nil {
			if content.GetMedia() != nil {
				if _, _, err := s.validateCaption(text, ents); err != nil {
					return err
				}
				preview, fetchLater = nil, false
			} else if strings.TrimSpace(text) == "" {
				return errInvalid("message text is empty")
			}
			sameText := m.Text == text && proto.Equal(&appv1.Message{Entities: content.GetEntities()}, &appv1.Message{Entities: ents}) &&
				(content.GetMedia() != nil || e.NoLinkPreview == (content.GetLinkPreview() == nil))
			if !sameText {
				newText, markEdited = text, true
				content.Entities, content.LinkPreview = ents, preview
			}
		}
		markupChanged := e.SetMarkup && !proto.Equal(content.GetReplyMarkup(), e.Markup)
		if markupChanged {
			content.ReplyMarkup = e.Markup
		}
		if markEdited || markupChanged {
			if err := t.rewriteMessage(ctx, c, botID, m, newText, content, markEdited, false); err != nil {
				return err
			}
		}
		if !markEdited {
			fetchLater = false
		}
		edited = m
		return nil
	})
	if err != nil {
		return nil, err
	}
	if fetchLater {
		s.attachPreviewLater(e.ChatID, e.Seq, edited.EditVersion, url)
	}
	rendered, _, err := s.renderMessages(ctx, s.pool, botID, []*messageRow{edited})
	if err != nil {
		return nil, err
	}
	return rendered[0], nil
}

// CheckBotPost reports whether the bot may post in the chat (and topic)
// now: membership, send permission, consent in private chats, a closed
// topic. It returns the topic a post would go to.
func (s *Service) CheckBotPost(ctx context.Context, botID, chatID, topicID int64) (int64, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, botID, false)
	if err != nil {
		return 0, err
	}
	return s.postable(ctx, s.pool, c, m, botID, topicID)
}

// MemberInfo is a chat member as the Bot API shows it.
type MemberInfo struct {
	UserID int64
	// Status is one of the MemberStatus values.
	Status string
	// Permissions are the effective ChatPermission bits (0 for former
	// members).
	Permissions uint32
}

func (c *chatRow) memberInfo(m *memberRow) MemberInfo {
	info := MemberInfo{UserID: m.UserID, Permissions: c.permsOf(m)}
	switch {
	case m.Banned:
		info.Status = MemberStatusBanned
	case m.Left:
		info.Status = MemberStatusLeft
	case m.Role == roleOwner:
		info.Status = MemberStatusOwner
	case m.Role == roleAdmin:
		info.Status = MemberStatusAdmin
	default:
		info.Status = MemberStatusMember
	}
	return info
}

// membersVisible opens a chat whose members me may list: a current member
// of a group, an admin of a channel.
func (s *Service) membersVisible(ctx context.Context, me, chatID int64) (*chatRow, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if c.Type == typePrivate {
		return nil, errInvalid("a private chat has no members to list")
	}
	if c.Type == typeChannel && !m.isAdmin() {
		return nil, errDenied("only admins see the members of a channel")
	}
	return c, nil
}

// ChatAdmins lists the owner and admins of a group or channel me is in,
// with the users rendered for me.
func (s *Service) ChatAdmins(ctx context.Context, me, chatID int64) ([]MemberInfo, []*appv1.User, error) {
	c, err := s.membersVisible(ctx, me, chatID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+memberColumns+` FROM chat_members m
		WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.role IN ('owner', 'admin')
		ORDER BY m.role = 'owner' DESC, m.joined_at, m.user_id`, c.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("chat: list admins: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*memberRow, error) { return scanMember(r) })
	if err != nil {
		return nil, nil, fmt.Errorf("chat: list admins: %w", err)
	}
	out := make([]MemberInfo, 0, len(list))
	ents := newEntitySet()
	for _, m := range list {
		out = append(out, c.memberInfo(m))
		ents.addUsers(me, m.UserID)
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, nil, err
	}
	return out, rendered.users[me], nil
}

// ChatMemberOf returns one member (current, former or banned) of a group
// or channel me is in; never a member is not found.
func (s *Service) ChatMemberOf(ctx context.Context, me, chatID, userID int64) (MemberInfo, []*appv1.User, error) {
	c, err := s.membersVisible(ctx, me, chatID)
	if err != nil {
		return MemberInfo{}, nil, err
	}
	m, err := s.memberRow(ctx, s.pool, chatID, userID)
	if err != nil {
		return MemberInfo{}, nil, err
	}
	ents := newEntitySet()
	ents.addUsers(me, userID)
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return MemberInfo{}, nil, err
	}
	return c.memberInfo(m), rendered.users[me], nil
}

// ChatBots returns the live bots that are current members of a group me
// is in (for the group command menu) and whether me is an admin there. A
// chat that is not a group has none.
func (s *Service) ChatBots(ctx context.Context, me, chatID int64) ([]int64, bool, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, false, err
	}
	if c.Type != typeGroup {
		return nil, false, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT b.user_id FROM chat_members m JOIN bots b ON b.user_id = m.user_id
		WHERE m.chat_id = $1 AND m.left_at IS NULL AND b.tenant_id = $2 AND b.deleted_at IS NULL
		ORDER BY m.joined_at, b.user_id`, chatID, s.cfg.TenantID)
	if err != nil {
		return nil, false, fmt.Errorf("chat: bots of a chat: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, false, fmt.Errorf("chat: bots of a chat: %w", err)
	}
	return ids, m.isAdmin(), nil
}
