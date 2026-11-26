package telegram

import (
	"strings"
	"testing"

	"github.com/gotd/td/tg"
)

func TestABotsFullUserBecomesItsInfo(t *testing.T) {
	full := tg.UserFull{ID: 5, About: "Bot đếm chữ"}
	full.SetBotInfo(tg.BotInfo{
		Description: "Tôi giúp đại ca đếm chữ",
		Commands:    []tg.BotCommand{{Command: "start", Description: "Bắt đầu"}, {Command: "dem", Description: "Đếm"}},
		MenuButton:  &tg.BotMenuButton{Text: "Mở", URL: "https://example.test/app"},
		DescriptionPhoto: &tg.Photo{ID: 7, AccessHash: 9, FileReference: []byte{0xab, 0xcd}, Sizes: []tg.PhotoSizeClass{
			&tg.PhotoSize{Type: "s", W: 90, H: 90},
			&tg.PhotoSizeProgressive{Type: "y", W: 800, H: 600},
			&tg.PhotoStrippedSize{Type: "i"},
		}},
	})
	info, ok, err := botInfoOf(&tg.UsersUserFull{FullUser: full, Users: []tg.UserClass{&tg.User{ID: 4, Username: "other"}, &tg.User{ID: 5, Username: "dem_chu_bot"}}})
	if err != nil || !ok {
		t.Fatalf("botInfoOf = ok %v, err %v", ok, err)
	}
	if info.Description != "Tôi giúp đại ca đếm chữ" || info.About != "Bot đếm chữ" || info.Username != "dem_chu_bot" || len(info.Commands) != 2 || info.Commands[1].Command != "dem" || !info.OpensApp {
		t.Fatalf("info = %+v", info)
	}
	if info.PhotoID != "7" || info.PhotoRef != "bot-photo:7:9:abcd:y" {
		t.Fatalf("photo = %q, %q (want the biggest size, 'y')", info.PhotoID, info.PhotoRef)
	}
	id, hash, ref, size, err := parseBotPhotoRef(strings.TrimPrefix(info.PhotoRef, botPhotoRef))
	if err != nil || id != 7 || hash != 9 || len(ref) != 2 || size != "y" {
		t.Fatalf("parse = %d %d %v %q %v", id, hash, ref, size, err)
	}
}

func TestAnythingButABotHasNoBotInfo(t *testing.T) {
	if _, ok, err := botInfoOf(&tg.UsersUserFull{FullUser: tg.UserFull{About: "người"}}); ok || err != nil {
		t.Fatalf("a person's full user gave ok %v, err %v", ok, err)
	}
	for _, bad := range []string{"", "1:2:zz:y", "x:2:ab:y", "1:2:ab:"} {
		if _, _, _, _, err := parseBotPhotoRef(bad); err == nil {
			t.Fatalf("parseBotPhotoRef(%q) accepted a bad ref", bad)
		}
	}
}
