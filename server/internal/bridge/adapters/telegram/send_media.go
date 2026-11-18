package telegram

import (
	"context"
	"errors"
	"fmt"
	"io"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
)

// fileSizeMax is the largest file Telegram takes from an ordinary account.
const fileSizeMax = 2000 << 20

// sendFiles sends the files of m: one as a message, several as an album. It
// returns Telegram's answer and the random id of each message.
func (c *conn) sendFiles(ctx context.Context, peer tg.InputPeerClass, m bridge.OutMessage, ents []tg.MessageEntityClass, reply tg.InputReplyToClass) (tg.UpdatesClass, []int64, error) {
	for _, f := range m.Media {
		if f.Size > fileSizeMax {
			return nil, nil, fmt.Errorf("%w: a file is over %d MB", bridge.ErrTooLarge, fileSizeMax>>20)
		}
	}
	randoms := make([]int64, len(m.Media))
	for i := range randoms {
		randoms[i] = m.RandomID + int64(i)
	}
	if len(m.Media) == 1 {
		media, err := c.uploaded(ctx, m.Media[0])
		if err != nil {
			return nil, nil, err
		}
		u, err := c.live.api().MessagesSendMedia(ctx, &tg.MessagesSendMediaRequest{
			Peer: peer, Media: media, Message: m.Text, Entities: ents, RandomID: randoms[0], ReplyTo: reply})
		return u, randoms, err
	}
	singles := make([]tg.InputSingleMedia, len(m.Media))
	for i, f := range m.Media {
		media, err := c.uploaded(ctx, f)
		if err != nil {
			return nil, nil, err
		}
		// Telegram wants each item as a file it already holds.
		held, err := c.live.api().MessagesUploadMedia(ctx, &tg.MessagesUploadMediaRequest{Peer: peer, Media: media})
		if err != nil {
			return nil, nil, err
		}
		in, err := heldMedia(held)
		if err != nil {
			return nil, nil, err
		}
		singles[i] = tg.InputSingleMedia{Media: in, RandomID: randoms[i]}
		if i == 0 {
			singles[i].Message, singles[i].Entities = m.Text, ents
		}
	}
	u, err := c.live.api().MessagesSendMultiMedia(ctx, &tg.MessagesSendMultiMediaRequest{Peer: peer, MultiMedia: singles, ReplyTo: reply})
	return u, randoms, err
}

// uploaded sends the bytes of f to Telegram and describes them as media to
// send: a photo as a photo, anything else as a document that keeps its name,
// type and, for video and audio, its size and length.
func (c *conn) uploaded(ctx context.Context, f bridge.OutMedia) (tg.InputMediaClass, error) {
	if f.Open == nil {
		return nil, errors.New("telegram: a file has no bytes")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("telegram: open file: %w", err)
	}
	defer func() { _ = rc.Close() }()
	name := f.Name
	if name == "" {
		name = "file"
	}
	in, err := uploader.NewUploader(c.live.api()).Upload(ctx, uploader.NewUpload(name, io.Reader(rc), f.Size))
	if err != nil {
		return nil, err
	}
	if f.Kind == "photo" {
		return &tg.InputMediaUploadedPhoto{File: in}, nil
	}
	attrs := []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: name}}
	switch f.Kind {
	case "video":
		attrs = append(attrs, &tg.DocumentAttributeVideo{Duration: f.Duration.Seconds(), W: f.Width, H: f.Height, SupportsStreaming: true})
	case "audio", "voice":
		attrs = append(attrs, &tg.DocumentAttributeAudio{Voice: f.Kind == "voice", Duration: int(f.Duration.Seconds())})
	}
	mime := f.MimeType
	if mime == "" {
		mime = "application/octet-stream"
	}
	return &tg.InputMediaUploadedDocument{File: in, MimeType: mime, Attributes: attrs}, nil
}

// heldMedia turns the answer of messages.uploadMedia into media referring to
// the stored file.
func heldMedia(m tg.MessageMediaClass) (tg.InputMediaClass, error) {
	switch v := m.(type) {
	case *tg.MessageMediaPhoto:
		if p, ok := v.Photo.AsNotEmpty(); ok {
			return &tg.InputMediaPhoto{ID: p.AsInput()}, nil
		}
	case *tg.MessageMediaDocument:
		if d, ok := v.Document.AsNotEmpty(); ok {
			return &tg.InputMediaDocument{ID: d.AsInput()}, nil
		}
	}
	return nil, fmt.Errorf("telegram: unexpected answer to a file upload: %T", m)
}
