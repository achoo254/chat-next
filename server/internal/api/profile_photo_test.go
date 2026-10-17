package api_test

import (
	"net/http"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// A person sets a profile photo they uploaded; who sees it follows their
// "who sees my profile photo" setting and never reaches someone they
// blocked, both on the user and for its download.
func TestProfilePhotoPrivacy(t *testing.T) {
	e := newMediaEnv(t, config.StorageFilesystem, nil)
	ctx := t.Context()
	an := e.member(t, "photoan")
	binh := e.member(t, "photobinh")
	// Binh can look An up through their private chat.
	if _, err := an.chats.CreatePrivate(ctx, connect.NewRequest(&appv1.CreatePrivateRequest{UserId: binh.userID})); err != nil {
		t.Fatal(err)
	}
	photo, err := e.upload(t, an, appv1.MediaKind_MEDIA_KIND_PHOTO, "me.jpg", photoWithGPS(t, 640, 640), nil)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := e.upload(t, binh, appv1.MediaKind_MEDIA_KIND_PHOTO, "x.jpg", photoWithGPS(t, 64, 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := an.users.UpdateProfile(ctx, connect.NewRequest(&appv1.UpdateProfileRequest{PhotoFileId: proto.String(theirs.GetFileId())})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("someone else's photo: %v", err)
	}
	updated, err := an.users.UpdateProfile(ctx, connect.NewRequest(&appv1.UpdateProfileRequest{PhotoFileId: proto.String(photo.GetFileId())}))
	if err != nil || updated.Msg.GetUser().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("set photo: %v, %v", updated, err)
	}

	seen := func() bool {
		t.Helper()
		users, err := binh.users.GetUsers(ctx, connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{an.userID}}))
		if err != nil || len(users.Msg.GetUsers()) != 1 {
			t.Fatalf("get users: %v, %v", users, err)
		}
		shown := users.Msg.GetUsers()[0].GetPhoto().GetFileId() == photo.GetFileId()
		resp, err := binh.media(e.env).GetFileUrls(ctx, connect.NewRequest(&appv1.GetFileUrlsRequest{Requests: []*appv1.GetFileUrlRequest{{
			FileId: photo.GetFileId(), Size: appv1.MediaSizeType_MEDIA_SIZE_TYPE_S,
			Context: &appv1.GetFileUrlRequest_UserPhotoOf{UserPhotoOf: an.userID},
		}}}))
		if err != nil {
			t.Fatal(err)
		}
		if url := !resp.Msg.GetResults()[0].GetUnavailable(); url != shown {
			t.Fatalf("user shows photo %v, download %v", shown, url)
		}
		return shown
	}
	setPhotoAudience := func(a appv1.PrivacyAudience) {
		t.Helper()
		if _, err := an.users.SetPrivacy(ctx, connect.NewRequest(&appv1.SetPrivacyRequest{ProfilePhoto: &a})); err != nil {
			t.Fatal(err)
		}
	}

	if !seen() {
		t.Fatal("everyone (the default) does not see the photo")
	}
	setPhotoAudience(appv1.PrivacyAudience_PRIVACY_AUDIENCE_CONTACTS)
	if seen() {
		t.Fatal("contacts only: someone not in An's contacts sees it")
	}
	if _, err := an.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: binh.userID}})); err != nil {
		t.Fatal(err)
	}
	if !seen() {
		t.Fatal("contacts only: a contact does not see it")
	}
	setPhotoAudience(appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY)
	if seen() {
		t.Fatal("nobody: a contact sees it")
	}
	self, err := an.users.GetUsers(ctx, connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{an.userID}}))
	if err != nil || self.Msg.GetUsers()[0].GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("An sees their own photo: %v, %v", self, err)
	}
	setPhotoAudience(appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE)
	if _, err := an.users.Block(ctx, connect.NewRequest(&appv1.BlockRequest{UserId: binh.userID})); err != nil {
		t.Fatal(err)
	}
	if seen() {
		t.Fatal("a blocked person sees the photo")
	}
	if _, err := an.users.Unblock(ctx, connect.NewRequest(&appv1.UnblockRequest{UserId: binh.userID})); err != nil {
		t.Fatal(err)
	}
	if !seen() {
		t.Fatal("unblocked: the photo does not come back")
	}
	if _, err := an.users.UpdateProfile(ctx, connect.NewRequest(&appv1.UpdateProfileRequest{PhotoFileId: proto.String("")})); err != nil {
		t.Fatal(err)
	}
	if seen() {
		t.Fatal("removed photo still shown")
	}
}

// Those allowed to change a group's info set its photo: members see it on
// the chat and download it, a service message says so, and others cannot.
func TestGroupPhoto(t *testing.T) {
	e := newMediaEnv(t, config.StorageFilesystem, nil)
	ctx := t.Context()
	an := e.member(t, "groupan")
	binh := e.member(t, "groupbinh")
	stranger := e.member(t, "groupstranger")
	if _, err := binh.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "groupan"}})); err != nil {
		t.Fatal(err)
	}
	created, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Ảnh nhóm", UserIds: []int64{binh.userID}}))
	if err != nil || len(created.Msg.GetFailures()) != 0 {
		t.Fatalf("create group: %v, %v", created, err)
	}
	chatID := created.Msg.GetChat().GetId()
	photo, err := e.upload(t, an, appv1.MediaKind_MEDIA_KIND_PHOTO, "group.jpg", photoWithGPS(t, 640, 640), nil)
	if err != nil {
		t.Fatal(err)
	}
	binhPhoto, err := e.upload(t, binh, appv1.MediaKind_MEDIA_KIND_PHOTO, "b.jpg", photoWithGPS(t, 64, 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Members cannot change the info by default.
	if _, err := binh.chats.UpdateChatInfo(ctx, connect.NewRequest(&appv1.UpdateChatInfoRequest{ChatId: chatID, PhotoFileId: proto.String(binhPhoto.GetFileId())})); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member sets the photo: %v", err)
	}
	updated, err := an.chats.UpdateChatInfo(ctx, connect.NewRequest(&appv1.UpdateChatInfoRequest{ChatId: chatID, PhotoFileId: proto.String(photo.GetFileId())}))
	if err != nil || updated.Msg.GetChat().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("set photo: %v, %v", updated, err)
	}
	got, err := binh.chats.GetChat(ctx, connect.NewRequest(&appv1.GetChatRequest{ChatId: chatID}))
	if err != nil || got.Msg.GetChat().GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("member's chat: %v, %v", got, err)
	}
	lastAction := func() *appv1.MessageAction {
		t.Helper()
		h, err := binh.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID, Limit: 1}))
		if err != nil || len(h.Msg.GetMessages()) != 1 {
			t.Fatalf("history: %v, %v", h, err)
		}
		return h.Msg.GetMessages()[0].GetAction()
	}
	if a := lastAction().GetPhotoChanged(); a.GetPhoto().GetFileId() != photo.GetFileId() {
		t.Fatalf("service message: %v", lastAction())
	}
	url := func(c *chatClients) *appv1.FileUrlResult {
		t.Helper()
		resp, err := c.media(e.env).GetFileUrls(ctx, connect.NewRequest(&appv1.GetFileUrlsRequest{Requests: []*appv1.GetFileUrlRequest{{
			FileId: photo.GetFileId(), Size: appv1.MediaSizeType_MEDIA_SIZE_TYPE_S,
			Context: &appv1.GetFileUrlRequest_ChatPhotoOf{ChatPhotoOf: chatID},
		}}}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg.GetResults()[0]
	}
	r := url(binh)
	if r.GetUnavailable() {
		t.Fatalf("member's photo url: %v", r)
	}
	resp := e.fetch(t, http.MethodGet, r.GetUrl(), nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download: %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if r := url(stranger); !r.GetUnavailable() {
		t.Fatalf("a non-member gets the photo: %v", r)
	}

	if _, err := an.chats.UpdateChatInfo(ctx, connect.NewRequest(&appv1.UpdateChatInfoRequest{ChatId: chatID, PhotoFileId: proto.String("")})); err != nil {
		t.Fatal(err)
	}
	if lastAction().GetPhotoRemoved() == nil {
		t.Fatalf("removal message: %v", lastAction())
	}
	if r := url(binh); !r.GetUnavailable() {
		t.Fatalf("removed photo url: %v", r)
	}
}
