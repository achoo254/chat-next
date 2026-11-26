package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

const botPictureID = "AAAAAAAAAAAAAAAAAAAAAA"

// externalBot makes a puppet of a Telegram bot in an account of owner, with what the bridge
// would have read about it, and its picture as a file of owner.
func (h *harness) externalBot(owner int64) (bot, other int64) {
	h.t.Helper()
	ctx := context.Background()
	chatID := h.group(owner)
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-ext-bot', '\x00')`, owner); err != nil {
		h.t.Fatal(err)
	}
	bot = h.externalPuppet(owner, chatID, "robot")
	other = h.externalPuppet(owner, chatID, "person")
	var fileID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO files (public_id, tenant_id, owner_id, kind, mime_type, size, file_hash, source_hash, object_key)
		VALUES ($1, $2, $3, 'photo', 'image/jpeg', 10, repeat('a', 64), repeat('b', 64), 'k/bot-picture') RETURNING id`,
		botPictureID, h.svc.cfg.TenantID, owner).Scan(&fileID); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `
		UPDATE external_users SET is_bot = true, bot_photo_file_id = $2, bot_info = $3::jsonb WHERE user_id = $1`,
		bot, fileID, `{"username":"dem_chu_bot","description":"Tôi đếm chữ","about":"Bot đếm chữ","opens_app":true,
		"commands":[{"command":"start","description":"Bắt đầu"},{"command":"dem","description":"Đếm"}],"photo_id":"d1"}`); err != nil {
		h.t.Fatal(err)
	}
	return bot, other
}

func TestABotOfAnotherAppAnswersGetBotInfoForTheOwnerOfItsAccountOnly(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	stranger := h.user("stranger")
	bot, person := h.externalBot(owner)

	got, ok, err := h.svc.ExternalBotInfo(ctx, owner, bot)
	if err != nil || !ok {
		t.Fatalf("ExternalBotInfo = ok %v, err %v", ok, err)
	}
	if got.GetDescription() != "Tôi đếm chữ" || got.GetAbout() != "Bot đếm chữ" || len(got.GetCommands()) != 2 || got.GetCommands()[1].GetCommand() != "dem" {
		t.Fatalf("info = %v", got)
	}
	if got.GetExternalApp() != "telegram" || got.GetOpenUrl() != "https://t.me/dem_chu_bot" || got.GetUser().GetUsername() != "dem_chu_bot" || !got.GetUser().GetIsBot() {
		t.Fatalf("app %q, open %q, user %v", got.GetExternalApp(), got.GetOpenUrl(), got.GetUser())
	}
	if got.GetDescriptionPhoto().GetFileId() != botPictureID || got.GetIsOwner() {
		t.Fatalf("picture %v, owner %v", got.GetDescriptionPhoto(), got.GetIsOwner())
	}
	if _, ok, _ := h.svc.ExternalBotInfo(ctx, stranger, bot); ok {
		t.Fatal("someone else got the info of a bot of the owner's account")
	}
	if _, ok, _ := h.svc.ExternalBotInfo(ctx, owner, person); ok {
		t.Fatal("a person was answered as a bot")
	}
}

func TestTheBotPictureIsServedToTheOwnerOfItsAccountOnly(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	stranger := h.user("stranger")
	bot, person := h.externalBot(owner)
	ask := func(viewer, of int64, file string) bool {
		t.Helper()
		got, err := h.svc.AuthorizeFiles(ctx, viewer, []*appv1.GetFileUrlRequest{{FileId: file, Context: &appv1.GetFileUrlRequest_BotDescriptionOf{BotDescriptionOf: of}}})
		if err != nil {
			t.Fatal(err)
		}
		return got[0] != nil
	}
	if !ask(owner, bot, botPictureID) {
		t.Fatal("the owner cannot see the picture of their bot")
	}
	if ask(stranger, bot, botPictureID) {
		t.Fatal("a stranger can see the picture")
	}
	if ask(owner, person, botPictureID) {
		t.Fatal("the picture is served under another user")
	}
	if ask(owner, bot, "BBBBBBBBBBBBBBBBBBBBBB") {
		t.Fatal("another file is served under the bot")
	}
}
