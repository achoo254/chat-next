package media

import (
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

// TestTheBotPictureIsServedOnlyWhileItIsTheBotsPictureAndTheViewerOwnsTheAccount: the grant for the picture
// a bot of another app shows is checked again by the media host, as profile photos are.
func TestTheBotPictureIsServedOnlyWhileItIsTheBotsPictureAndTheViewerOwnsTheAccount(t *testing.T) {
	s, _ := newTestService(t)
	ctx := t.Context()
	pool := s.pool
	var owner, bot, other int64
	for _, q := range []*int64{&owner, &bot, &other} {
		if err := pool.QueryRow(ctx, `SELECT coalesce(max(id), 0) + 1 FROM users`).Scan(q); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, tenant_id, idp_sub, username, name) VALUES ($1, 'primary', $2, $3, 'x')`,
			*q, "sub-"+strings.Repeat("a", 3)+string(rune('0'+*q%10))+string(rune('a'+*q%26)), "u"+string(rune('a'+*q%26))+string(rune('0'+*q%10))); err != nil {
			t.Fatal(err)
		}
	}
	var accountID int64
	if err := pool.QueryRow(ctx, `INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-1', '\x00') RETURNING id`, owner).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	f := s.storeTestFile(t, owner)
	if _, err := pool.Exec(ctx, `INSERT INTO external_users (account_id, external_user_id, user_id, is_bot, bot_photo_file_id) VALUES ($1, 'b1', $2, true, $3)`, accountID, bot, f.ID); err != nil {
		t.Fatal(err)
	}
	tokenOf := func(viewer, of int64) string {
		res := s.SignURL(viewer, Access{File: f, ChatID: BotDescriptionChat, Seq: of}, appv1.MediaSizeType_MEDIA_SIZE_TYPE_UNSPECIFIED)
		return res.GetUrl()[strings.LastIndex(res.GetUrl(), "/f/")+3:]
	}
	if _, status := s.authorize(ctx, tokenOf(owner, bot)); status != 200 {
		t.Fatalf("the owner of the account got %d for the bot's picture", status)
	}
	if _, status := s.authorize(ctx, tokenOf(other, bot)); status != 404 {
		t.Fatalf("someone else got %d for the bot's picture", status)
	}
	// A file that is not the one kept for the bot is refused, even with a grant for the bot.
	stray := s.storeTestFile(t, owner)
	res := s.SignURL(owner, Access{File: stray, ChatID: BotDescriptionChat, Seq: bot}, appv1.MediaSizeType_MEDIA_SIZE_TYPE_UNSPECIFIED)
	if _, status := s.authorize(ctx, res.GetUrl()[strings.LastIndex(res.GetUrl(), "/f/")+3:]); status != 404 {
		t.Fatalf("a file that is not the bot's picture got %d", status)
	}
}
