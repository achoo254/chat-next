package api_test

import (
	"net/http"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// The owner sets a bot's photo in the Developer Console with a photo they
// uploaded; everyone in the tenant sees it on the bot and downloads it with
// the user_photo_of context; removing it ends those downloads.
func TestBotPhoto(t *testing.T) {
	e := newMediaEnv(t, config.StorageFilesystem, nil)
	ctx := t.Context()
	owner := e.member(t, "photoowner")
	if resp, body := e.signIn(t, owner.http, "?reauth=1"); resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth: %d %q", resp.StatusCode, body)
	}
	opt := withOrigin(e.srv.URL)
	admin := appv1connect.NewBotAdminServiceClient(owner.http, e.srv.URL+"/rpc", opt)
	created, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "photo_bot", Name: "Photo"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := created.Msg.GetBot().GetUser().GetId()

	photo, err := e.upload(t, owner, appv1.MediaKind_MEDIA_KIND_PHOTO, "avatar.jpg", photoWithGPS(t, 640, 640), nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := e.upload(t, owner, appv1.MediaKind_MEDIA_KIND_DOCUMENT, "a.txt", []byte("not a photo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	other := e.member(t, "photoviewer")
	theirs, err := e.upload(t, other, appv1.MediaKind_MEDIA_KIND_PHOTO, "x.jpg", photoWithGPS(t, 64, 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{doc.GetFileId(), theirs.GetFileId(), "AAAAAAAAAAAAAAAAAAAAAA"} {
		_, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, PhotoFileId: proto.String(bad)}))
		if codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("photo %s: %v", bad, err)
		}
	}
	updated, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, PhotoFileId: proto.String(photo.GetFileId())}))
	if err != nil || updated.Msg.GetBot().GetUser().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("set photo: %v, %v", updated, err)
	}

	// Another user sees the photo on the bot and downloads it.
	resolved, err := other.users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "photo_bot"}))
	if err != nil || resolved.Msg.GetUser().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("resolve: %v, %v", resolved, err)
	}
	// The bot's profile (the composer and the bot link use it) carries it too.
	viewerBots := appv1connect.NewBotsServiceClient(other.http, e.srv.URL+"/rpc", opt)
	info, err := viewerBots.GetBotInfo(ctx, connect.NewRequest(&appv1.GetBotInfoRequest{BotId: botID}))
	if err != nil || info.Msg.GetUser().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("bot info: %v, %v", info, err)
	}
	photoURL := func(user int64, fileID string) *appv1.FileUrlResult {
		t.Helper()
		resp, err := other.media(e.env).GetFileUrls(ctx, connect.NewRequest(&appv1.GetFileUrlsRequest{Requests: []*appv1.GetFileUrlRequest{{
			FileId: fileID, Size: appv1.MediaSizeType_MEDIA_SIZE_TYPE_S,
			Context: &appv1.GetFileUrlRequest_UserPhotoOf{UserPhotoOf: user},
		}}}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg.GetResults()[0]
	}
	got := photoURL(botID, photo.GetFileId())
	if got.GetUnavailable() || got.GetUrl() == "" {
		t.Fatalf("photo url: %v", got)
	}
	resp := e.fetch(t, http.MethodGet, got.GetUrl(), nil, nil)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("download: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	_ = resp.Body.Close()
	// A person's photo context, or a file that is not the bot's photo, gives nothing.
	if r := photoURL(owner.userID, photo.GetFileId()); !r.GetUnavailable() {
		t.Fatalf("a person's photo: %v", r)
	}
	if r := photoURL(botID, theirs.GetFileId()); !r.GetUnavailable() {
		t.Fatalf("another file as the bot's photo: %v", r)
	}

	// Removed: no photo on the bot, and the issued URL stops working.
	if _, err := admin.UpdateBot(ctx, connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, PhotoFileId: proto.String("")})); err != nil {
		t.Fatal(err)
	}
	resolved, err = other.users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "photo_bot"}))
	if err != nil || resolved.Msg.GetUser().GetPhoto() != nil {
		t.Fatalf("after removal: %v, %v", resolved, err)
	}
	if r := photoURL(botID, photo.GetFileId()); !r.GetUnavailable() {
		t.Fatalf("url after removal: %v", r)
	}
	// The authorization cache (5 seconds) may still answer, as for a deleted
	// message; a new token is refused (above).
	resp = e.fetch(t, http.MethodGet, got.GetUrl(), nil, nil)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		t.Fatalf("old url: %d", resp.StatusCode)
	}
}
