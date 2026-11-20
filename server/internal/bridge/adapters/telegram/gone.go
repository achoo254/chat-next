package telegram

import (
	"context"
	"strconv"
	"strings"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// goneErrors are Telegram's answers, about a group or channel asked for by its id, that
// the account is no longer in it: deleted, or the account removed from a private one.
var goneErrors = map[string]bool{
	"CHANNEL_PRIVATE": true, "CHANNEL_INVALID": true, "CHAT_ID_INVALID": true, "CHAT_FORBIDDEN": true,
}

// ConversationGone implements bridge.GoneChecker. It asks Telegram about the group or
// channel itself; a private chat is never gone (deleting it on Telegram only clears it
// from the list), and a channel listed before its access hash was kept cannot be asked.
func (a *Adapter) ConversationGone(ctx context.Context, acct bridge.Account, conv, ref string) (bool, error) {
	kind, raw, _ := strings.Cut(conv, ":")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return false, nil
	}
	var ask func(api *tg.Client) (tg.MessagesChatsClass, error)
	switch kind + ":" {
	case prefixChannel:
		hash, err := strconv.ParseInt(ref, 10, 64)
		if err != nil {
			return false, nil
		}
		ask = func(api *tg.Client) (tg.MessagesChatsClass, error) {
			return api.ChannelsGetChannels(ctx, []tg.InputChannelClass{&tg.InputChannel{ChannelID: id, AccessHash: hash}})
		}
	case prefixChat:
		ask = func(api *tg.Client) (tg.MessagesChatsClass, error) { return api.MessagesGetChats(ctx, []int64{id}) }
	default:
		return false, nil
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return false, err
	}
	defer release()
	res, err := ask(c.live.api())
	if rpc, ok := tgerr.As(err); ok && goneErrors[rpc.Type] {
		return true, nil
	}
	if err != nil {
		return false, translate(err)
	}
	return goneFrom(res.GetChats()), nil
}

// goneFrom reads Telegram's answer about one group or channel: forbidden (deleted, or the
// account removed), deactivated (a basic group turned into a supergroup) or left.
func goneFrom(chats []tg.ChatClass) bool {
	if len(chats) == 0 {
		// Not an answer that the account is out: taking a live group for gone would stop
		// it, missing a gone one only leaves it as it was.
		return false
	}
	switch v := chats[0].(type) {
	case *tg.ChannelForbidden, *tg.ChatForbidden:
		return true
	case *tg.Channel:
		return v.Left
	case *tg.Chat:
		return v.Left || v.Deactivated
	}
	return false
}
