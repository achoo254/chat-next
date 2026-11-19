package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
)

// FetchMedia implements bridge.Adapter: the bytes of the photo or document
// of a message. ref is "<conversation>/<message id>": the message is read
// again so the file reference is fresh (Telegram's expire).
func (a *Adapter) FetchMedia(ctx context.Context, acct bridge.Account, ref string) (bridge.MediaStream, error) {
	if conv, ok := strings.CutPrefix(ref, groupPhotoRef); ok {
		return a.fetchGroupPhoto(ctx, acct, conv)
	}
	conv, rawID, ok := strings.Cut(ref, "/")
	id, err := strconv.Atoi(rawID)
	if !ok || err != nil {
		return nil, fmt.Errorf("telegram: bad media ref")
	}
	c, release, err := a.acquire(ctx, acct)
	if err != nil {
		return nil, err
	}
	peer, err := c.inputPeer(ctx, conv)
	if err != nil {
		release()
		return nil, err
	}
	loc, mime, size, err := c.mediaLocation(ctx, peer, id)
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

// mediaLocation reads one message and finds where its file is.
func (c *conn) mediaLocation(ctx context.Context, peer tg.InputPeerClass, id int) (tg.InputFileLocationClass, string, int64, error) {
	ids := []tg.InputMessageClass{&tg.InputMessageID{ID: id}}
	var res tg.MessagesMessagesClass
	var err error
	if ch, ok := peer.(*tg.InputPeerChannel); ok {
		res, err = c.live.api().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: ch.ChannelID, AccessHash: ch.AccessHash}, ID: ids})
	} else {
		res, err = c.live.api().MessagesGetMessages(ctx, ids)
	}
	if err != nil {
		return nil, "", 0, translate(err)
	}
	var raw []tg.MessageClass
	switch v := res.(type) {
	case *tg.MessagesMessages:
		raw = v.Messages
	case *tg.MessagesMessagesSlice:
		raw = v.Messages
	case *tg.MessagesChannelMessages:
		raw = v.Messages
	}
	for _, m := range raw {
		msg, ok := m.(*tg.Message)
		if !ok || msg.ID != id {
			continue
		}
		switch media := msg.Media.(type) {
		case *tg.MessageMediaPhoto:
			if photo, ok := media.Photo.(*tg.Photo); ok {
				return photoLocation(photo)
			}
		case *tg.MessageMediaDocument:
			if doc, ok := media.Document.(*tg.Document); ok {
				return &tg.InputDocumentFileLocation{ID: doc.ID, AccessHash: doc.AccessHash, FileReference: doc.FileReference}, doc.MimeType, doc.Size, nil
			}
		}
	}
	return nil, "", 0, errors.New("telegram: the message has no downloadable file")
}

// photoLocation picks the largest size of a photo.
func photoLocation(p *tg.Photo) (tg.InputFileLocationClass, string, int64, error) {
	best, bestSize, bestType := int64(-1), int64(0), ""
	for _, s := range p.Sizes {
		var area, size int64
		var typ string
		switch v := s.(type) {
		case *tg.PhotoSize:
			area, size, typ = int64(v.W)*int64(v.H), int64(v.Size), v.Type
		case *tg.PhotoSizeProgressive:
			if n := len(v.Sizes); n > 0 {
				area, size, typ = int64(v.W)*int64(v.H), int64(v.Sizes[n-1]), v.Type
			}
		}
		if typ != "" && area > best {
			best, bestSize, bestType = area, size, typ
		}
	}
	if bestType == "" {
		return nil, "", 0, errors.New("telegram: the photo has no downloadable size")
	}
	return &tg.InputPhotoFileLocation{ID: p.ID, AccessHash: p.AccessHash, FileReference: p.FileReference, ThumbSize: bestType}, "image/jpeg", bestSize, nil
}

// mediaStream is a download in progress.
type mediaStream struct {
	r     *io.PipeReader
	mime  string
	size  int64
	stop  func()
	close sync.Once
}

func (m *mediaStream) Read(p []byte) (int, error) { return m.r.Read(p) }
func (m *mediaStream) MimeType() string           { return m.mime }
func (m *mediaStream) Size() int64                { return m.size }

// Close stops the download and gives the connection back, once: a reader that gave
// up on a stalled download closes it while the caller still holds a deferred Close.
func (m *mediaStream) Close() error {
	m.close.Do(m.stop)
	return m.r.Close()
}
