package zalo

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"
	"unicode"

	"app.local/server/internal/bridge"
)

// Photos and files go to one person the owner talks with, like text (send.go),
// one Zalo message per file: an album of Chat is sent item by item, in order, each
// at least sendGap after the last, item i under RandomID+i. Zalo puts a caption only
// on a single photo, so the caption of a message rides on its first item when that
// is a photo and is refused otherwise (Chat's composer sends it as its own text).
// Videos, voice messages and stickers are not sent; a GIF or an MP4 file neither,
// since zca-js would send those as an animation or a video.
//
// The bytes reach the sidecar over stdin in file_chunk lines, then send_media asks
// it to upload them and post the message (zca-js sendMessage with one attachment
// taken from memory: nothing is written to disk).
//
// A file has no text to recognise an earlier try by, so a repeat of a RandomID
// whose try may have gone out is sent again only when the newest history page
// reaches back to that try and holds no photo or file of the owner since then
// that is not already the answer of another RandomID; otherwise it is left to the
// owner (errUnsure).

const (
	// maxFileBytes is the largest file sent to Zalo, as the files Chat copies in.
	maxFileBytes = 25 << 20
	// fileChunkBytes is the size of the piece of a file each file_chunk line carries.
	fileChunkBytes = 192 << 10
	// maxFilesPerMessage bounds an album.
	maxFilesPerMessage = 10
	// maxNameRunes bounds the file name Zalo shows.
	maxNameRunes = 120
)

// Tokens in the reason of a refused file, read by the web client to tell the owner why.
const (
	errFileNotSendable = "file_not_sendable"
	errFileCaption     = "file_caption"
)

// noText stands for a file in the sent log: no text hashes to all zeros, so a
// file is never matched to a text message.
var noText textHash

// photoExtensions are the names zca-js uploads as a photo; mimePhotos gives the
// extension of a photo by its type.
var (
	photoExtensions = map[string]bool{"jpg": true, "jpeg": true, "png": true, "webp": true}
	mimePhotos      = map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
	// refusedExtensions zca-js sends as something else than a file (a video, an animation).
	refusedExtensions = map[string]bool{"mp4": true, "gif": true}
)

// outFile is one file to send, checked.
type outFile struct {
	kind          string // "photo" or "file", as the sidecar takes it
	name          string // cleaned; never logged
	size          int64
	width, height int
	open          func() (io.ReadCloser, error)
}

// planFiles checks the files of m and says how each goes to Zalo; nil for a text message.
func planFiles(m bridge.OutMessage) ([]outFile, error) {
	if len(m.Media) == 0 {
		return nil, nil
	}
	if len(m.Media) > maxFilesPerMessage {
		return nil, fmt.Errorf("%w: %s: at most %d files go to Zalo in one message", bridge.ErrNotAllowed, errFileNotSendable, maxFilesPerMessage)
	}
	files := make([]outFile, 0, len(m.Media))
	for _, item := range m.Media {
		f, err := planFile(item)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	if m.Text != "" && files[0].kind != "photo" {
		return nil, fmt.Errorf("%w: %s: Zalo takes a caption only on a photo; send the text as its own message", bridge.ErrNotAllowed, errFileCaption)
	}
	return files, nil
}

// planFile checks one file: a photo, a document or an audio file of 1 byte to 25 MiB.
func planFile(item bridge.OutMedia) (outFile, error) {
	notSendable := func(why string) error {
		return fmt.Errorf("%w: %s: %s", bridge.ErrNotAllowed, errFileNotSendable, why)
	}
	switch {
	case item.Kind != "photo" && item.Kind != "document" && item.Kind != "audio":
		return outFile{}, notSendable("only photos and files go to Zalo, not videos, voice messages or stickers")
	case item.Size <= 0:
		return outFile{}, notSendable("the file is empty")
	case item.Size > maxFileBytes:
		return outFile{}, fmt.Errorf("%w: files over 25 MiB are not sent to Zalo", bridge.ErrTooLarge)
	case item.Open == nil:
		return outFile{}, errors.New("zalo: the file of the message cannot be read; nothing was sent")
	}
	f := outFile{kind: "file", name: cleanFileName(item.Name), size: item.Size, open: item.Open}
	measured := item.Width > 0 && item.Height > 0
	if ext, ok := mimePhotos[strings.ToLower(item.MimeType)]; ok && item.Kind == "photo" && measured {
		base := strings.TrimSuffix(f.name, path.Ext(f.name))
		if base == "" {
			base = "photo"
		}
		f.kind, f.name, f.width, f.height = "photo", base+"."+ext, item.Width, item.Height
		return f, nil
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(f.name), "."))
	switch {
	case refusedExtensions[ext]:
		return outFile{}, notSendable("Zalo would send this file as a video or an animation")
	case photoExtensions[ext] && !measured:
		// zca-js uploads every jpg, png or webp as a photo, which needs its size.
		return outFile{}, notSendable("an image without its size cannot be sent")
	case photoExtensions[ext]:
		f.kind, f.width, f.height = "photo", item.Width, item.Height
	case f.name == "":
		f.name = "file"
	}
	return f, nil
}

// cleanFileName keeps the last part of a path, without control characters or the
// ones a multipart header or a file system would choke on, trimmed, and at most
// maxNameRunes long with its extension kept.
func cleanFileName(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`"<>:|?*`, r) || r == unicode.ReplacementChar {
			return -1
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	runes := []rune(name)
	if len(runes) <= maxNameRunes {
		return name
	}
	ext := []rune(path.Ext(name))
	if len(ext) > 16 {
		ext = nil
	}
	return strings.TrimRight(string(runes[:maxNameRunes-len(ext)]), " .") + string(ext)
}

// sendFiles sends the files of m one by one; page is a history page already read
// for this call, if any. A file that fails stops the rest: the files before it
// keep their answer in the sent log, so a retry does not send them again.
func (a *Adapter) sendFiles(ctx context.Context, st *sendState, side *sidecar, m bridge.OutMessage, files []outFile, page *historyPage) (bridge.SentRef, error) {
	var ref bridge.SentRef
	for i, f := range files {
		caption := ""
		if i == 0 {
			caption = m.Text
		}
		one, err := a.sendFile(ctx, st, side, m, m.RandomID+int64(i), f, caption, &page)
		if err != nil {
			return bridge.SentRef{}, err
		}
		if i == 0 {
			ref.Date = one.Date
		}
		ref.IDs = append(ref.IDs, one.IDs...)
	}
	return ref, nil
}

// sendFile sends one file under rid, unless an earlier try of rid created it or may have.
func (a *Adapter) sendFile(ctx context.Context, st *sendState, side *sidecar, m bridge.OutMessage, rid int64, f outFile, caption string, page **historyPage) (bridge.SentRef, error) {
	att, seen := st.log.lookup(rid)
	switch {
	case seen && att.ref != nil:
		return *att.ref, nil
	case !seen && m.RetrySince.IsZero():
		return a.sendFileNow(ctx, st, side, m.Conversation, rid, f, caption) // new
	case seen && a.now().Sub(att.lastTry) < a.timing.mediaAnswer:
		return bridge.SentRef{}, fmt.Errorf("%w (the last try is too recent)", errUnsure)
	}
	// Tried here with an open outcome, or a retry of a call that may have gone out.
	st.log.open(rid, m.Conversation, noText, m.RetrySince.Add(-zaloClockSlack))
	att, _ = st.log.lookup(rid)
	if *page == nil {
		p, err := a.readHistory(ctx, side, m.Conversation)
		if err != nil {
			return bridge.SentRef{}, fmt.Errorf("%w: %w", errUnsure, err)
		}
		*page = &p
	}
	if !(*page).reaches(att.lower) {
		return bridge.SentRef{}, fmt.Errorf("%w (the history page does not reach back to the first try)", errUnsure)
	}
	if st.log.anyUnclaimed((*page).ownFiles(m.Conversation), att.lower) {
		return bridge.SentRef{}, fmt.Errorf("%w (the history holds a photo or file that may be the earlier try)", errUnsure)
	}
	return a.sendFileNow(ctx, st, side, m.Conversation, rid, f, caption) // the history shows no earlier copy
}

// sendFileNow hands the bytes to the sidecar, then, at least sendGap after the
// account's last send, asks it to send them.
func (a *Adapter) sendFileNow(ctx context.Context, st *sendState, side *sidecar, conv string, rid int64, f outFile, caption string) (bridge.SentRef, error) {
	id := a.nextRequestID()
	if err := streamFile(ctx, side, id, f); err != nil {
		return bridge.SentRef{}, err
	}
	if err := a.waitGap(ctx, st); err != nil {
		return bridge.SentRef{}, err
	}
	to, group, _ := target(conv) // checkOutgoing refused any other conversation
	st.log.tried(rid, conv, noText)
	st.lastSend = a.now()
	ev, err := side.request(ctx, command{Cmd: cmdSendMedia, ID: id, To: to, Group: group, Text: caption,
		Kind: f.kind, Name: f.name, Size: f.size, Width: f.width, Height: f.height}, a.timing.mediaAnswer)
	return a.answered(st, rid, ev, err)
}

// streamFile writes the file to the sidecar in file_chunk lines under id. Nothing
// is sent to Zalo; a file that is not the size Chat recorded is not sent at all.
func streamFile(ctx context.Context, side *sidecar, id string, f outFile) error {
	r, err := f.open()
	if err != nil {
		return errors.New("zalo: the file of the message cannot be read; nothing was sent")
	}
	defer func() { _ = r.Close() }()
	buf := make([]byte, fileChunkBytes)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := io.ReadFull(r, buf)
		if n > 0 {
			total += int64(n)
			if total > f.size {
				return errors.New("zalo: the file is larger than Chat recorded; nothing was sent")
			}
			if err := side.send(command{Cmd: cmdFileChunk, ID: id, Data: base64.StdEncoding.EncodeToString(buf[:n])}); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			break
		}
		if readErr != nil {
			return errors.New("zalo: the file of the message cannot be read; nothing was sent")
		}
	}
	if total != f.size {
		return errors.New("zalo: the file is smaller than Chat recorded; nothing was sent")
	}
	return nil
}

// ownFiles are the owner's messages of the page that are not text (photos, files
// and anything else), the ones an earlier try of a file could be.
func (p historyPage) ownFiles(conv string) []ownMessage {
	var out []ownMessage
	for _, h := range p.messages {
		at, ok := zaloMillis(h.TS)
		if !h.Self || string(h.MsgType) == msgTypeText || !ok || !zaloID.MatchString(string(h.MsgID)) {
			continue
		}
		out = append(out, ownMessage{conv: conv, text: noText, id: string(h.MsgID), date: at})
	}
	return out
}

// anyUnclaimed reports whether a message of ms dated since then is not the known
// answer of a RandomID.
func (l *sentLog) anyUnclaimed(ms []ownMessage, since time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, m := range ms {
		if _, claimed := l.claimed[m.id]; !claimed && !m.date.Before(since) {
			return true
		}
	}
	return false
}
