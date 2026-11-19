package telegram

import (
	"errors"
	"testing"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tgerr"
)

func TestARefusalAboutOneConversationIsNotAllowedAndOtherErrorsStayAsTheyAre(t *testing.T) {
	for _, typ := range []string{"CHAT_ADMIN_REQUIRED", "PEER_ID_INVALID", "CHANNEL_PRIVATE"} {
		if err := translate(tgerr.New(400, typ)); !errors.Is(err, bridge.ErrNotAllowed) {
			t.Errorf("%s: %v, want ErrNotAllowed", typ, err)
		}
	}
	if err := translate(tgerr.New(401, "AUTH_KEY_UNREGISTERED")); !errors.Is(err, bridge.ErrSessionRevoked) {
		t.Errorf("a dead session: %v", err)
	}
	if err := translate(tgerr.New(500, "INTERNAL")); errors.Is(err, bridge.ErrNotAllowed) || errors.Is(err, bridge.ErrSessionRevoked) {
		t.Errorf("an internal error became %v", err)
	}
}
