package telegram

import (
	"context"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// internalRetryWaits are the pauses before asking Telegram again after an internal
// error of its own (code 500, such as RPC_MCGET_FAIL or INTERNAL). Telegram documents
// these as transient and safe to repeat; without the retry one of them ended the whole
// account's sync and reconnected it. Variable so tests can shorten it.
var internalRetryWaits = []time.Duration{500 * time.Millisecond, 2 * time.Second}

// retryInternal repeats a call that Telegram answered with an internal error, up to
// len(internalRetryWaits) more times. The request is sent again unchanged: a send keeps
// its random_id, so Telegram answers with the message it already took. A call with no
// such key that Telegram may have applied before failing (onceOnly) is not repeated. Any
// other error, and the last internal one, is returned as it is.
func retryInternal() telegram.Middleware {
	return telegram.MiddlewareFunc(func(next tg.Invoker) telegram.InvokeFunc {
		return func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
			err := next.Invoke(ctx, input, output)
			if onceOnly(input) {
				return err
			}
			for _, wait := range internalRetryWaits {
				if !isInternal(err) {
					return err
				}
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					return err
				case <-timer.C:
				}
				err = next.Invoke(ctx, input, output)
			}
			return err
		}
	})
}

// isInternal reports an error Telegram raised for a fault on its side (code 500).
// RANDOM_ID_DUPLICATE shares the code but says the send already went through.
func isInternal(err error) bool {
	rpc, ok := tgerr.As(err)
	return ok && rpc.IsCode(500) && rpc.Type != "RANDOM_ID_DUPLICATE"
}

// onceOnly reports a call that Telegram may have carried out before the fault and that
// has no key to recognise a repeat: a second invite link, or an error for a person
// already added or a group already deleted, would follow.
func onceOnly(input bin.Encoder) bool {
	switch input.(type) {
	case *tg.MessagesExportChatInviteRequest, *tg.ChannelsInviteToChannelRequest, *tg.MessagesAddChatUserRequest,
		*tg.ChannelsDeleteChannelRequest, *tg.MessagesDeleteChatRequest:
		return true
	}
	return false
}
