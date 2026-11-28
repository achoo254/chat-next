package zalo

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"app.local/server/internal/bridge"
)

// Message types that carry a file. The sidecar forwards zca-js's message
// content as is; for these it is an attachment object (zca-js TAttachmentContent:
// title, description, href, thumb, childnumber, action, params, type), href being
// the file on Zalo's CDN. Not yet seen on a real account.
const (
	msgTypePhoto = "chat.photo"
	msgTypeFile  = "share.file"
	msgTypeVideo = "chat.video.msg"
	msgTypeVoice = "chat.voice"
	msgTypeGIF   = "chat.gif"
)

// Labels of files Chat does not copy from Zalo, in the engine's words (engine
// mediaLabels), so a Zalo voice message reads like a Telegram one that was not copied.
const (
	labelPhoto = "[Ảnh]"
	labelFile  = "[Tệp]"
	labelVideo = "[Video]"
	labelVoice = "[Tin nhắn thoại]"
	labelGIF   = "[GIF]"
)

// mediaRef starts the media ref of a file of a message: "media:<https URL>".
const mediaRef = "media:"

// mediaURLMax bounds a file URL: it is kept in memory with the message until the
// engine copies it. Zalo's signed links are far shorter.
const mediaURLMax = 2048

// mediaFileNameMax bounds the name of a file, in bytes.
const mediaFileNameMax = 255

// mediaTimeout bounds one file download, body included (25 MiB at least
// ~1.7 Mbit/s); the engine also gives up a download idle for a minute.
const mediaTimeout = 2 * time.Minute

// mediaHostSuffixes are the only hosts a file of a message is downloaded from.
// Zalo puts the href on its own CDN; this list is the one an independent zca-js
// client downloads from without the session (OpenClaw zalouser, monitor.ts:
// "*.zdn.vn", "*.dlfl.vn", "*.flchat.vn", "*.dlmd.me"), plus zadn.vn, the image
// CDN of profile photos (avatarHostSuffix).
var mediaHostSuffixes = []string{".zdn.vn", ".zadn.vn", ".dlfl.vn", ".flchat.vn", ".dlmd.me"}

// mediaAllowed reports whether a file URL may be kept and fetched.
func mediaAllowed(raw string) bool {
	return cdnURLAllowed(raw, mediaURLMax, mediaHostSuffixes)
}

// attachment is the part of zca-js's attachment content the adapter reads.
type attachment struct {
	Title  string          `json:"title"`
	Href   string          `json:"href"`
	Params json.RawMessage `json:"params"` // JSON text in a string (or, defensively, an object)
}

// attachmentParams is what the adapter reads of an attachment's params.
type attachmentParams struct {
	FileSize looseString `json:"fileSize"`
}

// messageContent is the text, the files and the entities of a message: a text, a
// file to copy, a shared link, or the label of content not copied.
func messageContent(ev wireEvent) (string, []bridge.Media, []bridge.Entity) {
	if text, media, ents, ok := linkContent(string(ev.MsgType), ev.Content); ok {
		return text, media, ents
	}
	text, media := plainContent(ev)
	return text, media, nil
}

// plainContent is the text and the files of a message that is not a shared link.
func plainContent(ev wireEvent) (string, []bridge.Media) {
	switch string(ev.MsgType) {
	case msgTypeText:
		if text, ok := textContent(ev.Content); ok {
			return text, nil
		}
	case msgTypeSticker:
		return stickerContent(ev.Content)
	case msgTypePhoto:
		return fileContent(ev.Content, "photo", labelPhoto)
	case msgTypeFile:
		return fileContent(ev.Content, "document", labelFile)
	case msgTypeVideo:
		return fileContent(ev.Content, "video", labelVideo)
	case msgTypeVoice:
		return labelVoice, nil
	case msgTypeGIF:
		return labelGIF, nil
	}
	return labelUnsupported, nil
}

// stickerURL is where Zalo serves the picture of a sticker by its id: a public
// image on its CDN host, fetched without the session like the other files. Seen
// answering 200 with a PNG for a real sticker id and 404 for an unknown one.
const stickerURL = "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?size=130&eid="

// stickerIDPattern is what a sticker id looks like: digits, as the content gives it.
var stickerIDPattern = regexp.MustCompile(`^[0-9]{1,18}$`)

// stickerContent turns a sticker message (its content names only the sticker's id
// and pack) into the picture the engine copies; without a usable id it is the label.
func stickerContent(content json.RawMessage) (string, []bridge.Media) {
	var s struct {
		ID looseString `json:"id"`
	}
	if err := json.Unmarshal(content, &s); err != nil || !stickerIDPattern.MatchString(string(s.ID)) {
		return labelSticker, nil
	}
	url := stickerURL + string(s.ID)
	if !mediaAllowed(url) {
		return labelSticker, nil
	}
	return "", []bridge.Media{{Ref: mediaRef + url, Kind: "sticker", MimeType: "image/png"}}
}

// fileContent turns an attachment into the file the engine copies. Without a URL
// on Zalo's CDN there is nothing to fetch: the message is the label instead (with
// the name of a file, as the engine words a file it did not copy).
func fileContent(content json.RawMessage, kind, label string) (string, []bridge.Media) {
	var att attachment
	if err := json.Unmarshal(content, &att); err != nil {
		return label, nil
	}
	name := ""
	if kind == "document" {
		name = strings.TrimSpace(att.Title)
		if len(name) > mediaFileNameMax {
			name = truncateUTF8(name, mediaFileNameMax)
		}
	}
	if !mediaAllowed(att.Href) {
		if name != "" {
			return strings.TrimSuffix(label, "]") + ": " + name + "]", nil
		}
		return label, nil
	}
	return "", []bridge.Media{{Ref: mediaRef + att.Href, Kind: kind, Name: name, Size: paramsFileSize(att.Params)}}
}

// paramsFileSize is the size an attachment's params state, 0 when unknown.
func paramsFileSize(raw json.RawMessage) int64 {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		raw = json.RawMessage(text)
	}
	var p attachmentParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0
	}
	n, err := strconv.ParseInt(string(p.FileSize), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// fetchMessageFile streams the file of a message from Zalo's CDN, without the
// session: the href is a link anyone holding it can download.
func fetchMessageFile(ctx context.Context, cdn *cdnClient, raw string) (bridge.MediaStream, error) {
	return cdn.get(ctx, raw, mediaAllowed, mediaTimeout)
}
