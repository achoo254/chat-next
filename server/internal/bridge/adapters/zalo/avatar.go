package zalo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"app.local/server/internal/bridge"
)

// avatarRef starts the media ref of a person's photo: "avatar:<https URL>".
const avatarRef = "avatar:"

// avatarHostSuffix is the only place a photo is downloaded from: Zalo's image CDN
// (s120-ava-talk.zadn.vn and the like). The URL comes from Zalo's answer, so it is
// checked before it is stored and again before it is fetched.
const avatarHostSuffix = ".zadn.vn"

// avatarURLMax bounds a photo URL kept in external_users.
const avatarURLMax = 1024

// avatarTimeout bounds one photo download: it runs in the account's sync loop.
const avatarTimeout = 10 * time.Second

// avatarAllowed reports whether a photo URL may be stored and fetched: https on the
// default port, a host under avatarHostSuffix, no credentials.
func avatarAllowed(raw string) bool {
	return cdnURLAllowed(raw, avatarURLMax, []string{avatarHostSuffix})
}

// withAvatar gives a participant the photo the sidecar found; an empty or unexpected
// URL leaves the photo unknown, so Chat keeps what it has.
func withAvatar(p *bridge.Participant, raw string) {
	if !avatarAllowed(raw) {
		return
	}
	p.PhotoKnown, p.PhotoID, p.PhotoRef = true, raw, avatarRef+raw
}

// fetchAvatar streams a person's photo from Zalo's CDN (cdnClient: no redirect off
// the image CDN, public addresses only, size cap) and refuses what is not an image.
func fetchAvatar(ctx context.Context, cdn *cdnClient, raw string) (bridge.MediaStream, error) {
	stream, err := cdn.get(ctx, raw, avatarAllowed, avatarTimeout)
	if err != nil {
		return nil, err
	}
	if mime := stream.MimeType(); !strings.HasPrefix(mime, "image/") {
		_ = stream.Close()
		return nil, fmt.Errorf("zalo: photo download answered %q", safeCode(strings.ReplaceAll(mime, "/", "_")))
	}
	return stream, nil
}
