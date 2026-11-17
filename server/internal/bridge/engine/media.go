package engine

import (
	"context"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/media"
)

// defaultMediaMax is the largest file the bridge copies, in bytes: bigger
// ones stay in the other app and the message says so.
const defaultMediaMax = 25 << 20

// uploadKind maps a media kind of an adapter to a kind of Chat's media
// service; ok is false for what Chat cannot show (stickers, locations,
// polls, contacts).
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
// label, never dropped).
func (r *runner) copyFile(ctx context.Context, m bridge.Message) *appv1.Message {
	if r.e.mediaSvc == nil || len(m.Media) == 0 {
		return nil
	}
	med := m.Media[0]
	kind, ok := uploadKind(med)
	if !ok {
		return nil
	}
	limit := r.e.cfg.MediaMaxBytes
	if med.Size > limit {
		return nil
	}
	stream, err := retryRateLimit(ctx, func() (bridge.MediaStream, error) {
		return r.adapter.FetchMedia(ctx, r.acct, med.Ref)
	})
	if err != nil {
		r.logger.Warn("copying a file failed; the message is imported with a label", "kind", med.Kind, "reason", err.Error())
		return nil
	}
	defer func() { _ = stream.Close() }()
	if size := stream.Size(); size > limit {
		return nil
	}
	file, err := r.e.mediaSvc.UploadStream(ctx, r.account.OwnerID, media.StreamUpload{
		Kind: kind, FileName: fileNameOf(med), Body: io.LimitReader(stream, limit+1), MaxBytes: limit,
	})
	if err != nil {
		r.logger.Warn("storing a file failed; the message is imported with a label", "kind", med.Kind, "reason", err.Error())
		return nil
	}
	return &appv1.Message{Media: file.Ref()}
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
