package engine_test

import (
	"context"
	"strings"
	"testing"

	"app.local/server/internal/bridge"
)

func (e *env) usernameOf(person string) string {
	e.t.Helper()
	var u string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT u.username FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id = $2`, e.account, person).Scan(&u); err != nil {
		e.t.Fatal(err)
	}
	return u
}

func TestAPuppetTakesTheStatedUsernameAndTheSecondHolderKeepsThePlaceholder(t *testing.T) {
	e := newEnv(t)
	a := bridge.Participant{ID: "u-a", Name: "An", Username: "hotline_an"}
	b := bridge.Participant{ID: "u-b", Name: "Bình", Username: "hotline_an"}
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &a}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", a, "một", 0), e.msg("2", b, "hai", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"một", "hai"})
	if got := e.usernameOf("u-a"); got != "hotline_an" {
		t.Fatalf("first holder has %q", got)
	}
	if got := e.usernameOf("u-b"); !strings.HasPrefix(got, "ext_") {
		t.Fatalf("second holder has %q, want the placeholder name", got)
	}
}

func TestAPuppetWithoutAStatedNameKeepsThePlaceholderUntilItStatesOne(t *testing.T) {
	e := newEnv(t)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	if got := e.usernameOf(lan.ID); !strings.HasPrefix(got, "ext_") {
		t.Fatalf("got %q", got)
	}
	named := lan
	named.Username = "lan_pham"
	e.pushDM("2", named, "hai", 1)
	e.waitTexts(chatID, []string{"chào", "hai"})
	if got := e.usernameOf(lan.ID); got != "lan_pham" {
		t.Fatalf("got %q after the name was stated", got)
	}
	renamed := lan
	renamed.Username = "lan_moi"
	e.pushDM("3", renamed, "ba", 2)
	e.waitTexts(chatID, []string{"chào", "hai", "ba"})
	if got := e.usernameOf(lan.ID); got != "lan_pham" {
		t.Fatalf("an adopted name moved to %q", got)
	}
}
