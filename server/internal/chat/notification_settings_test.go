package chat

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

func TestNotificationSettings(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	defaults := &appv1.NotificationSettings{
		PrivateEnabled: true, PrivatePreview: true, GroupsEnabled: true, GroupsPreview: true,
		ChannelsEnabled: true, ChannelsPreview: true, Sound: appv1.NotificationSound_NOTIFICATION_SOUND_DEFAULT,
	}
	got, err := h.svc.GetNotificationSettings(ctx, a)
	if err != nil || !proto.Equal(got, defaults) {
		t.Fatalf("defaults = %v, %v", got, err)
	}

	off, on := false, true
	sound := appv1.NotificationSound_NOTIFICATION_SOUND_SOFT
	resp, err := h.svc.SetNotificationSettings(ctx, a, &appv1.SetNotificationSettingsRequest{
		GroupsEnabled: &off, ChannelsPreview: &off, Sound: &sound, BadgeMuted: &on,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := proto.Clone(defaults).(*appv1.NotificationSettings)
	want.GroupsEnabled, want.ChannelsPreview, want.Sound, want.BadgeMuted = false, false, sound, true
	if !proto.Equal(resp.GetSettings(), want) || resp.GetAck().GetPts() == 0 {
		t.Fatalf("set = %v", resp)
	}
	if got, _ := h.svc.GetNotificationSettings(ctx, a); !proto.Equal(got, want) {
		t.Fatalf("stored = %v", got)
	}
	// Only my settings change.
	if got, _ := h.svc.GetNotificationSettings(ctx, b); !proto.Equal(got, defaults) {
		t.Fatalf("other user = %v", got)
	}

	// My sessions get the whole settings, in realtime and from the log.
	tail := h.logOf(a)
	if s := tail[len(tail)-1].GetNotificationSettings().GetSettings(); !proto.Equal(s, want) {
		t.Fatalf("log tail = %v", tail[len(tail)-1])
	}
	h.drain()
	var live *appv1.NotificationSettings
	for _, u := range h.sink.updatesOf(a) {
		if s := u.GetNotificationSettings(); s != nil {
			live = s.GetSettings()
		}
	}
	if !proto.Equal(live, want) {
		t.Fatalf("realtime = %v", live)
	}
	for _, u := range h.sink.updatesOf(b) {
		if u.GetNotificationSettings() != nil {
			t.Fatalf("other user got %v", u)
		}
	}

	// A change to the same values writes nothing.
	if same, err := h.svc.SetNotificationSettings(ctx, a, &appv1.SetNotificationSettingsRequest{GroupsEnabled: &off}); err != nil ||
		same.GetAck().GetPts() != 0 || !proto.Equal(same.GetSettings(), want) {
		t.Fatalf("no-op = %v, %v", same, err)
	}
	for _, bad := range []appv1.NotificationSound{appv1.NotificationSound_NOTIFICATION_SOUND_UNSPECIFIED, 9} {
		if _, err := h.svc.SetNotificationSettings(ctx, a, &appv1.SetNotificationSettingsRequest{Sound: &bad}); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("sound %v: %v", bad, err)
		}
	}
}
