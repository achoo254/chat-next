package engine_test

import (
	"context"
	"testing"

	"app.local/server/internal/bridge"
)

// puppetFlags reads what the database records for the puppet standing for participant id.
func (e *env) puppetFlags(t *testing.T, id string) (externalBot, userBot bool) {
	t.Helper()
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT x.is_bot, u.is_bot FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id = $2`, e.account, id).Scan(&externalBot, &userBot); err != nil {
		t.Fatal(err)
	}
	return externalBot, userBot
}

func TestABotOfTheOtherAppIsRecordedOnItsPuppetNotAsABotOfThisSystem(t *testing.T) {
	e := newEnv(t)
	robot := bridge.Participant{ID: "u-robot", Name: "Robot", Username: "robot_bot", IsBot: true}
	conv := bridge.Conversation{ID: "dm-bot", Kind: bridge.ConvBot, Peer: &robot}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm-bot", e.msg("1", robot, "xin chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"xin chào"})
	externalBot, userBot := e.puppetFlags(t, robot.ID)
	if !externalBot {
		t.Fatal("external_users.is_bot = false for a bot of the other app")
	}
	if userBot {
		t.Fatal("users.is_bot = true: a puppet is not a bot of this system")
	}
}

func TestAPersonIsNotMarkedAsABotAndTheFlagFollowsTheOtherApp(t *testing.T) {
	e := newEnv(t)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào đại ca", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào đại ca"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	if externalBot, _ := e.puppetFlags(t, lan.ID); externalBot {
		t.Fatal("a person was marked as a bot")
	}
	// The other app now reports the same contact as a bot (a later live message): the flag follows.
	asBot := lan
	asBot.IsBot = true
	live := e.msg("2", asBot, "tin mới", 1)
	live.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &live})
	e.waitTexts(chatID, []string{"chào đại ca", "tin mới"})
	if externalBot, _ := e.puppetFlags(t, lan.ID); !externalBot {
		t.Fatal("the flag did not follow the other app")
	}
}
