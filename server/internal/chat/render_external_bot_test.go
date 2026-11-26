package chat

import (
	"context"
	"testing"
)

func TestAPuppetOfABotOfTheOtherAppIsShownAsABotButIsNotOneOfThisSystem(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-bot', '\x00')`, owner); err != nil {
		t.Fatal(err)
	}
	robot := h.externalPuppet(owner, chatID, "robot")
	person := h.externalPuppet(owner, chatID, "person")
	if _, err := h.st.Pool().Exec(ctx, `UPDATE external_users SET is_bot = true WHERE user_id = $1`, robot); err != nil {
		t.Fatal(err)
	}
	users, err := loadUsers(ctx, h.st.Pool(), h.svc.cfg.TenantID, []int64{robot, person, owner})
	if err != nil {
		t.Fatal(err)
	}
	if got := users[robot].render(owner, false); !got.GetIsBot() {
		t.Fatal("the puppet of a Telegram bot is not shown as a bot")
	}
	if users[robot].IsBot {
		t.Fatal("the puppet is a bot of this system (users.is_bot)")
	}
	if got := users[person].render(owner, false); got.GetIsBot() {
		t.Fatal("a person's puppet is shown as a bot")
	}
	if got := users[owner].render(owner, false); got.GetIsBot() {
		t.Fatal("the owner is shown as a bot")
	}
}
