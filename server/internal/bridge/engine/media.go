package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf16"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/media"
)

// defaultMediaMax is the largest file the bridge copies, in bytes: bigger
// ones stay in the other app and the message says so.
const defaultMediaMax = 25 << 20

// uploadKind maps a media kind of an adapter to a kind of Chat's media
// service; ok is false for what Chat cannot show (animated Lottie stickers,
// locations, polls, contacts).
func uploadKind(m bridge.Media) (appv1.MediaKind, bool) {
	switch m.Kind {
	case "photo":
		return appv1.MediaKind_MEDIA_KIND_PHOTO, true
	case "video":
		return appv1.MediaKind_MEDIA_KIND_VIDEO, true
	case "voice":
		return appv1.MediaKind_MEDIA_KIND_VOICE, true
	case "audio":
		return appv1.MediaKind_MEDIA_KIND_AUDIO, true
	case "document", "gif":
		return appv1.MediaKind_MEDIA_KIND_DOCUMENT, true
	case "sticker":
		// A static sticker is an image and a video sticker a clip; the
		// animated Lottie kind (application/x-tgsticker) needs a player
		// Chat does not have, so it stays a label.
		switch m.MimeType {
		case "image/webp", "image/png":
			return appv1.MediaKind_MEDIA_KIND_PHOTO, true
		case "video/webm":
			return appv1.MediaKind_MEDIA_KIND_VIDEO, true
		}
	}
	return 0, false
}

// mediaLabels are the words that stand in for a file the bridge did not
// copy (kinds Chat cannot show, files over the size cap, a failed copy).
var mediaLabels = map[string]string{
	"photo": "Ảnh", "video": "Video", "voice": "Tin nhắn thoại", "audio": "Âm thanh", "sticker": "Nhãn dán",
	"gif": "GIF", "document": "Tệp", "location": "Vị trí", "contact": "Danh bạ", "poll": "Bình chọn",
}

// labelFor is the line that tells a reader what was in a message but is not
// shown: empty when the file was copied, or there was none.
func labelFor(m bridge.Message, copied bool) string {
	if copied || len(m.Media) == 0 {
		return ""
	}
	label, ok := mediaLabels[m.Media[0].Kind]
	if !ok {
		label = "Nội dung không hỗ trợ"
	}
	if name := m.Media[0].Name; name != "" && m.Media[0].Kind == "document" {
		label += ": " + name
	}
	return "[" + label + "]"
}

// withLabel puts label (and a line break when there is text) before the
// text, moving the entities with it.
func withLabel(label, text string, ents []bridge.Entity) (string, []bridge.Entity) {
	if label == "" {
		return text, ents
	}
	prefix := label
	if text != "" {
		prefix += "\n"
	}
	shift := len(utf16.Encode([]rune(prefix)))
	moved := make([]bridge.Entity, len(ents))
	for i, e := range ents {
		e.Offset += shift
		moved[i] = e
	}
	return prefix + text, moved
}

// copyFile downloads the file of m through the adapter and stores it as a
// file of the account's owner. It returns the message content that carries
// it, or nil when nothing was copied (no media service, a kind Chat cannot
// show, over the cap, or a failure: the message is then imported with a
// label, never dropped). A long wait the other app asks for during an import
// comes back as the error, so the batch is put off instead of labelled.
func (r *runner) copyFile(ctx context.Context, m bridge.Message) (*appv1.Message, error) {
	if r.e.mediaSvc == nil || len(m.Media) == 0 {
		return nil, nil
	}
	med := m.Media[0]
	kind, ok := uploadKind(med)
	if !ok {
		return nil, nil
	}
	limit := r.e.cfg.MediaMaxBytes
	if med.Size > limit {
		return nil, nil
	}
	stream, err := retryRateLimit(ctx, func() (bridge.MediaStream, error) {
		return r.adapter.FetchMedia(ctx, r.acct, med.Ref)
	})
	var wait *bridge.RateLimitError
	if errors.As(err, &wait) {
		// Only an import gets the wait back (see deferLongWaits): it puts the batch off,
		// nothing written yet, instead of importing the message with a label for good.
		return nil, err
	}
	if err != nil {
		r.logger.Warn("copying a file failed; the message is imported with a label", "kind", med.Kind, "reason", err.Error())
		return nil, nil
	}
	defer func() { _ = stream.Close() }()
	if size := stream.Size(); size > limit {
		return nil, nil
	}
	body, unwatch := watched(ctx, stream)
	defer unwatch()
	file, err := r.uploadPaced(ctx, media.StreamUpload{
		Kind: kind, FileName: fileNameOf(med), Body: io.LimitReader(body, limit+1), MaxBytes: limit,
	})
	if err != nil {
		r.logger.Warn("storing a file failed; the message is imported with a label", "kind", med.Kind, "reason", err.Error())
		return nil, nil
	}
	return &appv1.Message{Media: file.Ref()}, nil
}

// uploadRetryWait is how long an import waits when the owner's upload rate is
// used up: the limit refills at two files a second, so half a second frees a
// slot.
const uploadRetryWait = 500 * time.Millisecond

// uploadPaced stores the file as the account's owner and, when the owner's
// upload rate is used up (an import copies many files at once), waits and
// tries again instead of giving the file up. The rate check comes before the
// body is read, so the same body can be offered again.
func (r *runner) uploadPaced(ctx context.Context, in media.StreamUpload) (*media.File, error) {
	for {
		file, err := r.e.mediaSvc.UploadStream(ctx, r.account.OwnerID, in)
		if !errors.Is(err, media.ErrRateLimited) {
			return file, err
		}
		if err := sleep(ctx, uploadRetryWait); err != nil {
			return nil, err
		}
	}
}

// fileNameOf is the name given to the stored file.
func fileNameOf(m bridge.Media) string {
	if m.Name != "" {
		return m.Name
	}
	ext := ""
	switch m.Kind {
	case "photo":
		ext = ".jpg"
	case "video":
		ext = ".mp4"
	case "voice":
		ext = ".ogg"
	case "audio":
		ext = ".mp3"
	}
	if i := strings.LastIndexByte(m.MimeType, '/'); i >= 0 && ext == "" {
		ext = "." + m.MimeType[i+1:]
	}
	return fmt.Sprintf("%s%s", m.Kind, ext)
}

// fileIdle is how long a download from the other app may go without a byte before it
// is given up: a stalled download (seen in production) otherwise holds the whole run.
var fileIdle = 60 * time.Second

// watched closes stream when no byte came for fileIdle, or when ctx ends, so a Read
// stuck on a stalled download returns. The returned stop ends the watch.
func watched(ctx context.Context, stream bridge.MediaStream) (io.Reader, func()) {
	idle := fileIdle // read once: the watch goroutine must not race a change of it
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go func() {
		tick := time.NewTicker(idle / 6)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				_ = stream.Close()
				return
			case <-tick.C:
				if time.Since(time.Unix(0, last.Load())) > idle {
					_ = stream.Close()
					return
				}
			}
		}
	}()
	return readerFunc(func(p []byte) (int, error) {
		n, err := stream.Read(p)
		if n > 0 {
			last.Store(time.Now().UnixNano())
		}
		return n, err
	}), func() { close(done) }
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }
