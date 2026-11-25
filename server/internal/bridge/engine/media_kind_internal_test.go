package engine

import (
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
)

func TestUploadKindSticker(t *testing.T) {
	cases := map[string]struct {
		kind appv1.MediaKind
		ok   bool
	}{
		"image/webp":              {appv1.MediaKind_MEDIA_KIND_PHOTO, true},
		"video/webm":              {appv1.MediaKind_MEDIA_KIND_VIDEO, true},
		"application/x-tgsticker": {0, false},
		"":                        {0, false},
	}
	for mime, want := range cases {
		kind, ok := uploadKind(bridge.Media{Kind: "sticker", MimeType: mime})
		if kind != want.kind || ok != want.ok {
			t.Errorf("sticker %q: got (%v, %v), want (%v, %v)", mime, kind, ok, want.kind, want.ok)
		}
	}
}
