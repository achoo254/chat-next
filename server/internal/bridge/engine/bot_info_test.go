package engine_test

import (
	"context"
	"image/color"
	"strings"
	"testing"

	"app.local/server/internal/bridge"
)

// botInfoOf reads what the database holds about the bot standing for participant id.
func (e *env) botInfoOf(t *testing.T, id string) (json string, hasPhoto bool) {
	t.Helper()
	var info *string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT bot_info::text, bot_photo_file_id IS NOT NULL FROM external_users WHERE account_id = $1 AND external_user_id = $2`,
		e.account, id).Scan(&info, &hasPhoto); err != nil {
		t.Fatal(err)
	}
	if info == nil {
		return "", hasPhoto
	}
	return *info, hasPhoto
}

func TestABotsInfoAndPictureAreReadOnceAndKeptOnItsPuppet(t *testing.T) {
	e := newEnvWithMedia(t, true)
	robot := bridge.Participant{ID: "u-robot", Name: "Robot", Username: "robot_bot", IsBot: true}
	e.fake.SetBotInfo(robot.ID, bridge.BotInfo{
		Description: "Tôi giúp đại ca đếm chữ", About: "Bot đếm chữ", OpensApp: true,
		Commands: []bridge.BotCommand{{Command: "start", Description: "Bắt đầu"}, {Command: "dem", Description: "Đếm"}},
		PhotoID:  "d1", PhotoRef: "person-photo:robot:d1",
	})
	e.fake.SetPersonPhoto("person-photo:robot:d1", jpegOf(t, color.RGBA{B: 200, A: 255}))
	conv := bridge.Conversation{ID: "dm-bot", Kind: bridge.ConvBot, Peer: &robot}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm-bot", e.msg("1", robot, "xin chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"xin chào"})
	e.eventually(func() bool { _, photo := e.botInfoOf(t, robot.ID); return photo }, func() string { return "the bot's info and picture did not come in" })
	info, _ := e.botInfoOf(t, robot.ID)
	for _, want := range []string{"Tôi giúp đại ca đếm chữ", "Bot đếm chữ", `"command": "dem"`, `"opens_app": true`, `"photo_id": "d1"`} {
		if !strings.Contains(info, want) {
			t.Fatalf("bot_info = %s, want it to hold %q", info, want)
		}
	}
	// Read again only when old: the look repeats, the bot is not asked again.
	calls := e.fake.BotInfoCalls()
	again := e.msg("2", robot, "tin mới", 1)
	again.Conversation = "dm-bot"
	e.fake.Push(bridge.Event{Message: &again})
	e.waitTexts(chatID, []string{"xin chào", "tin mới"})
	if got := e.fake.BotInfoCalls(); got != calls {
		t.Fatalf("the bot was asked %d times after the first read, want none", got-calls)
	}
}

func TestAPersonIsNeverAskedForBotInfo(t *testing.T) {
	e := newEnv(t)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào đại ca", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào đại ca"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "no backfill" })
	if got := e.fake.BotInfoCalls(); got != 0 {
		t.Fatalf("a person was asked for bot info %d times", got)
	}
}
