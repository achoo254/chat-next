package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
)

var _ bridge.PhotoWriter = (*Adapter)(nil)

// groupPhotoRef starts the media ref of a group's current photo: "group-photo:<conversation>".
const groupPhotoRef = "group-photo:"

// photoID names a photo; empty for none.
func photoID(p tg.PhotoClass) string {
	if photo, ok := p.(*tg.Photo); ok {
		return strconv.FormatInt(photo.ID, 10)
	}
	return ""
}

// groupPhoto reads the current photo of a group.
func (c *conn) groupPhoto(ctx context.Context, peer tg.InputPeerClass) (*tg.Photo, error) {
	var p tg.PhotoClass
	switch v := peer.(type) {
	case *tg.InputPeerChannel:
		full, err := c.live.api().ChannelsGetFullChannel(ctx, &tg.InputChannel{ChannelID: v.ChannelID, AccessHash: v.AccessHash})
		if err != nil {
			return nil, translate(err)
		}
		if cf, ok := full.FullChat.(*tg.ChannelFull); ok {
			p = cf.ChatPhoto
		}
	case *tg.InputPeerChat:
		full, err := c.live.api().MessagesGetFullChat(ctx, v.ChatID)
		if err != nil {
			return nil, translate(err)
		}
		if cf, ok := full.FullChat.(*tg.ChatFull); ok {
			p, _ = cf.GetChatPhoto()
		}
	}
	photo, ok := p.(*tg.Photo)
	if !ok {
		return nil, errors.New("telegram: the group has no photo")
	}
	return photo, nil
}

// fetchGroupPhoto streams the largest size of a group's current photo.
func (a *Adapter) fetchGroupPhoto(ctx context.Context, acct bridge.Account, conv string) (bridge.MediaStream, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		release()
		return nil, err
	}
	photo, err := c.groupPhoto(ctx, peer)
	if err != nil {
		release()
		return nil, err
	}
	loc, mime, size, err := photoLocation(photo)
	if err != nil {
		release()
		return nil, err
	}
	dlCtx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	go func() {
		_, err := downloader.NewDownloader().Download(c.live.api(), loc).Stream(dlCtx, pw)
		_ = pw.CloseWithError(translate(err))
	}()
	return &mediaStream{r: pr, mime: mime, size: size, stop: func() { cancel(); release() }}, nil
}

// SetGroupPhoto implements bridge.PhotoWriter.
func (a *Adapter) SetGroupPhoto(ctx context.Context, acct bridge.Account, conv string, photo *bridge.OutMedia) (string, error) {
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return "", err
	}
	defer release()
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		return "", err
	}
	var in tg.InputChatPhotoClass = &tg.InputChatPhotoEmpty{}
	if photo != nil {
		if photo.Open == nil {
			return "", errors.New("telegram: the photo has no bytes")
		}
		rc, err := photo.Open()
		if err != nil {
			return "", fmt.Errorf("telegram: open photo: %w", err)
		}
		file, err := uploader.NewUploader(c.live.api()).Upload(ctx, uploader.NewUpload("photo.jpg", rc, photo.Size))
		_ = rc.Close()
		if err != nil {
			return "", translate(err)
		}
		up := &tg.InputChatUploadedPhoto{}
		up.SetFile(file)
		in = up
	}
	switch v := peer.(type) {
	case *tg.InputPeerChannel:
		_, err = c.live.api().ChannelsEditPhoto(ctx, &tg.ChannelsEditPhotoRequest{Channel: &tg.InputChannel{ChannelID: v.ChannelID, AccessHash: v.AccessHash}, Photo: in})
	case *tg.InputPeerChat:
		_, err = c.live.api().MessagesEditChatPhoto(ctx, &tg.MessagesEditChatPhotoRequest{ChatID: v.ChatID, Photo: in})
	default:
		return "", fmt.Errorf("%w: only a group has a photo to change", bridge.ErrNotAllowed)
	}
	if err := translatePin(err); err != nil {
		return "", err
	}
	info, _, err := c.groupInfo(ctx, peer)
	if err != nil {
		return "", err
	}
	return info.PhotoID, nil
}
