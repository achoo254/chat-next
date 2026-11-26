package telegram

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"
	"strings"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
)

// botPhotoRef starts the media ref of the picture a bot shows above its description:
// "bot-photo:<photo id>:<access hash>:<file reference in hex>:<size type>". The file
// reference expires, so the engine fetches the picture as soon as it has read the info.
const botPhotoRef = "bot-photo:"

var _ bridge.BotInfoReader = (*Adapter)(nil)

// BotInfo implements bridge.BotInfoReader with users.getFullUser.
func (a *Adapter) BotInfo(ctx context.Context, acct bridge.Account, participant string) (bridge.BotInfo, bool, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return bridge.BotInfo{}, false, err
	}
	defer release()
	peer, err := c.inputPeer(ctx, "user:"+participant)
	if err != nil {
		return bridge.BotInfo{}, false, err
	}
	user, ok := inputUserOf(peer)
	if !ok {
		return bridge.BotInfo{}, false, nil
	}
	full, err := c.live.api().UsersGetFullUser(ctx, user)
	if err != nil {
		return bridge.BotInfo{}, false, translate(err)
	}
	return botInfoOf(full)
}

// inputUserOf is the user an input peer names.
func inputUserOf(peer tg.InputPeerClass) (tg.InputUserClass, bool) {
	switch p := peer.(type) {
	case *tg.InputPeerUser:
		return &tg.InputUser{UserID: p.UserID, AccessHash: p.AccessHash}, true
	case *tg.InputPeerSelf:
		return &tg.InputUserSelf{}, true
	}
	return nil, false
}

// botInfoOf maps the full user of a bot; ok is false for anyone else.
func botInfoOf(res *tg.UsersUserFull) (bridge.BotInfo, bool, error) {
	full := res.FullUser
	bot, ok := full.GetBotInfo()
	if !ok {
		return bridge.BotInfo{}, false, nil
	}
	info := bridge.BotInfo{Description: bot.Description, About: full.About}
	for _, u := range res.Users {
		if user, ok := u.(*tg.User); ok && user.ID == full.ID {
			info.Username = user.Username
		}
	}
	for _, c := range bot.Commands {
		info.Commands = append(info.Commands, bridge.BotCommand{Command: c.Command, Description: c.Description})
	}
	switch bot.MenuButton.(type) {
	case *tg.BotMenuButton:
		info.OpensApp = true
	}
	if photo, ok := bot.DescriptionPhoto.(*tg.Photo); ok {
		if size, ok := largestPhotoSize(photo.Sizes); ok {
			info.PhotoID = strconv.FormatInt(photo.ID, 10)
			info.PhotoRef = botPhotoRef + info.PhotoID + ":" + strconv.FormatInt(photo.AccessHash, 10) + ":" + hex.EncodeToString(photo.FileReference) + ":" + size
		}
	}
	return info, true, nil
}

// largestPhotoSize is the type of the biggest size of a photo Telegram can download by type.
func largestPhotoSize(sizes []tg.PhotoSizeClass) (string, bool) {
	best, bestArea := "", -1
	for _, s := range sizes {
		switch v := s.(type) {
		case *tg.PhotoSize:
			if area := v.W * v.H; area > bestArea {
				best, bestArea = v.Type, area
			}
		case *tg.PhotoSizeProgressive:
			if area := v.W * v.H; area > bestArea {
				best, bestArea = v.Type, area
			}
		}
	}
	return best, best != ""
}

// parseBotPhotoRef reads the parts of a bot photo ref (without its prefix).
func parseBotPhotoRef(ref string) (id, hash int64, fileRef []byte, size string, err error) {
	parts := strings.Split(ref, ":")
	if len(parts) != 4 || parts[3] == "" {
		return 0, 0, nil, "", fmt.Errorf("telegram: bad bot photo ref")
	}
	if id, err = strconv.ParseInt(parts[0], 10, 64); err != nil {
		return 0, 0, nil, "", fmt.Errorf("telegram: bad bot photo ref")
	}
	if hash, err = strconv.ParseInt(parts[1], 10, 64); err != nil {
		return 0, 0, nil, "", fmt.Errorf("telegram: bad bot photo ref")
	}
	if fileRef, err = hex.DecodeString(parts[2]); err != nil {
		return 0, 0, nil, "", fmt.Errorf("telegram: bad bot photo ref")
	}
	return id, hash, fileRef, parts[3], nil
}

// fetchBotPhoto streams the picture a bot shows above its description.
func (a *Adapter) fetchBotPhoto(ctx context.Context, acct bridge.Account, ref string) (bridge.MediaStream, error) {
	id, hash, fileRef, size, err := parseBotPhotoRef(ref)
	if err != nil {
		return nil, err
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	loc := &tg.InputPhotoFileLocation{ID: id, AccessHash: hash, FileReference: fileRef, ThumbSize: size}
	dlCtx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	go func() {
		_, err := downloader.NewDownloader().Download(c.live.api(), loc).Stream(dlCtx, pw)
		_ = pw.CloseWithError(translate(err))
	}()
	return &mediaStream{r: pr, mime: "image/jpeg", stop: func() { cancel(); release() }}, nil
}
