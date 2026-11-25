package telegram

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
)

// userPhotoRef starts the media ref of a person's profile photo:
// "user-photo:<user id>:<access hash>:<photo id>". The access hash travels in the
// ref because a person met only in a group is not in the account's dialogs, so
// inputPeer could not find them.
const userPhotoRef = "user-photo:"

// withUserPhoto fills the photo of a participant from the user Telegram sent.
// A "min" user carries an access hash that cannot be used to ask for anything,
// so their photo stays unknown until Telegram sends the full user.
func withUserPhoto(p *bridge.Participant, u *tg.User) {
	if u.Min {
		return
	}
	hash, ok := u.GetAccessHash()
	if !ok {
		return
	}
	p.PhotoKnown = true
	photo, ok := u.Photo.(*tg.UserProfilePhoto)
	if !ok || photo.PhotoID == 0 {
		return // none, or hidden from this account
	}
	p.PhotoID = strconv.FormatInt(photo.PhotoID, 10)
	p.PhotoRef = userPhotoRef + strconv.FormatInt(u.ID, 10) + ":" + strconv.FormatInt(hash, 10) + ":" + p.PhotoID
}

// parseUserPhotoRef reads the parts of a user photo ref (without its prefix).
func parseUserPhotoRef(ref string) (user, hash, photo int64, err error) {
	parts := strings.Split(ref, ":")
	if len(parts) != 3 {
		return 0, 0, 0, fmt.Errorf("telegram: bad user photo ref")
	}
	var nums [3]int64
	for i, s := range parts {
		if nums[i], err = strconv.ParseInt(s, 10, 64); err != nil {
			return 0, 0, 0, fmt.Errorf("telegram: bad user photo ref")
		}
	}
	return nums[0], nums[1], nums[2], nil
}

// fetchUserPhoto streams the large size of a person's profile photo.
func (a *Adapter) fetchUserPhoto(ctx context.Context, acct bridge.Account, ref string) (bridge.MediaStream, error) {
	user, hash, photo, err := parseUserPhotoRef(ref)
	if err != nil {
		return nil, err
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	loc := &tg.InputPeerPhotoFileLocation{Big: true, Peer: &tg.InputPeerUser{UserID: user, AccessHash: hash}, PhotoID: photo}
	dlCtx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	go func() {
		_, err := downloader.NewDownloader().Download(c.live.api(), loc).Stream(dlCtx, pw)
		_ = pw.CloseWithError(translate(err))
	}()
	return &mediaStream{r: pr, mime: "image/jpeg", stop: func() { cancel(); release() }}, nil
}
