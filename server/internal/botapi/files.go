package botapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"slices"
	"strconv"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/media"
)

// File methods: sending photos, videos, audio, voice and documents (one or
// an album) by multipart upload or by the file_id of a file the bot can
// see, and reading a file with a short-lived download URL. Uploads go
// through the media service like the apps' (type sniffing, metadata
// stripping, renditions, the owner's quota). Bots never make the server
// fetch a URL for them.

// UploadBodyMax bounds a multipart request (all its files and fields); it
// is also the largest file a bot uploads (photos: media.PhotoMaxBytes).
const UploadBodyMax = 50 << 20

// formMemory is how much of a multipart body is kept in memory; larger
// files spill to temporary files removed after the request.
const formMemory = 8 << 20

type mediaRequest struct {
	ChatID     int64         `json:"chat_id"`
	TopicID    int64         `json:"topic_id"`
	Kind       string        `json:"kind"`
	FileID     string        `json:"file_id"`
	Text       string        `json:"text"`
	Entities   []wire.Entity `json:"entities"`
	ParseMode  string        `json:"parse_mode"`
	ReplyToSeq int64         `json:"reply_to_seq"`
	RandomID   int64         `json:"random_id"`
}

type albumItem struct {
	Kind      string        `json:"kind"`
	FileID    string        `json:"file_id"`
	Attach    string        `json:"attach"`
	Text      string        `json:"text"`
	Entities  []wire.Entity `json:"entities"`
	ParseMode string        `json:"parse_mode"`
	RandomID  int64         `json:"random_id"`
}

type albumRequest struct {
	ChatID     int64       `json:"chat_id"`
	TopicID    int64       `json:"topic_id"`
	ReplyToSeq int64       `json:"reply_to_seq"`
	Items      []albumItem `json:"items"`
}

// Form fields that carry JSON (numbers, lists); the others are strings.
var (
	mediaJSONFields = []string{"chat_id", "topic_id", "reply_to_seq", "random_id", "entities"}
	albumJSONFields = []string{"chat_id", "topic_id", "reply_to_seq", "items"}
)

// sendMedia posts one file with a caption: a multipart upload (part
// "file" and the other fields as form fields; entities as JSON) or a JSON
// body with file_id.
func (s *Service) sendMedia(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req mediaRequest
	files, cleanup, err := decodeMedia(r, &req, mediaJSONFields)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	if err := checkID("chat_id", req.ChatID); err != nil {
		return nil, err
	}
	if err := checkRandomID(req.RandomID); err != nil {
		return nil, err
	}
	text, ents, err := s.parseText(req.Text, req.Entities, req.ParseMode)
	if err != nil {
		return nil, err
	}
	upload, err := pickFile(files, "file", req.FileID, req.Kind)
	if err != nil {
		return nil, err
	}
	for name := range files {
		if name != "file" {
			return nil, errBadRequest("unexpected multipart part %q (the file goes in \"file\")", name)
		}
	}
	if err := s.readyToSend(ctx, bot, req.ChatID, req.TopicID); err != nil {
		return nil, err
	}
	fileID := req.FileID
	if upload != nil {
		if fileID, err = s.upload(ctx, bot, upload); err != nil {
			return nil, err
		}
	}
	sent, err := s.chat.SendMedia(ctx, bot.ID, &appv1.SendMediaRequest{
		ChatId: req.ChatID, TopicId: req.TopicID, FileId: fileID, Text: text, Entities: ents, ReplyToSeq: req.ReplyToSeq,
		RandomId: req.RandomID,
	})
	if err != nil {
		return nil, err
	}
	return s.messageResult(ctx, bot, sent.GetMessage())
}

// sendAlbum posts 2 to 10 files as one album: items name a file_id or the
// multipart part ("attach") holding the file.
func (s *Service) sendAlbum(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	var req albumRequest
	files, cleanup, err := decodeMedia(r, &req, albumJSONFields)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	if err := checkID("chat_id", req.ChatID); err != nil {
		return nil, err
	}
	if n := len(req.Items); n < 2 || n > s.chat.Config().AlbumSizeMax {
		return nil, errBadRequest("items must hold 2 to %d files", s.chat.Config().AlbumSizeMax)
	}
	items := make([]*appv1.AlbumItem, len(req.Items))
	uploads := make([]*filePart, len(req.Items))
	used := map[string]bool{}
	for i, it := range req.Items {
		if err := checkRandomID(it.RandomID); err != nil {
			return nil, err
		}
		text, ents, err := s.parseText(it.Text, it.Entities, it.ParseMode)
		if err != nil {
			return nil, itemError(i, err)
		}
		if it.Attach != "" && used[it.Attach] {
			return nil, errBadRequest("items[%d]: the part %q is attached twice", i, it.Attach)
		}
		used[it.Attach] = it.Attach != ""
		if it.Attach == "" && it.FileID == "" {
			return nil, errBadRequest("items[%d] needs file_id or attach", i)
		}
		if it.Attach != "" && it.FileID != "" {
			return nil, errBadRequest("items[%d] takes either file_id or attach", i)
		}
		if uploads[i], err = pickFile(files, it.Attach, it.FileID, it.Kind); err != nil {
			return nil, itemError(i, err)
		}
		items[i] = &appv1.AlbumItem{FileId: it.FileID, Text: text, Entities: ents, RandomId: it.RandomID}
	}
	for name := range files {
		if !used[name] {
			return nil, errBadRequest("the part %q is not attached to any item", name)
		}
	}
	if err := s.readyToSend(ctx, bot, req.ChatID, req.TopicID); err != nil {
		return nil, err
	}
	for i, up := range uploads {
		if up == nil {
			continue
		}
		if items[i].FileId, err = s.upload(ctx, bot, up); err != nil {
			return nil, err
		}
	}
	sent, err := s.chat.SendAlbum(ctx, bot.ID, &appv1.SendAlbumRequest{
		ChatId: req.ChatID, TopicId: req.TopicID, ReplyToSeq: req.ReplyToSeq, Items: items,
	})
	if err != nil {
		return nil, err
	}
	return s.messagesResult(ctx, bot, req.ChatID, sent.GetMessages())
}

// itemError names the album item an error is about.
func itemError(i int, err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		out := *ae
		out.description = fmt.Sprintf("items[%d]: %s", i, ae.description)
		return &out
	}
	return err
}

// readyToSend applies the send limits and checks the bot may post there
// before any file is stored.
func (s *Service) readyToSend(ctx context.Context, bot *botadmin.Bot, chatID, topicID int64) error {
	if err := s.allowSend(bot, chatID); err != nil {
		return err
	}
	_, err := s.chat.CheckBotPost(ctx, bot.ID, chatID, topicID)
	return err
}

// filePart is an uploaded file of a multipart request with its kind.
type filePart struct {
	kind   appv1.MediaKind
	header *multipart.FileHeader
}

// pickFile returns the uploaded part name (nil for a file_id) after
// checking that exactly one of them is given and the kind of an upload.
func pickFile(files map[string]*multipart.FileHeader, name, fileID, kind string) (*filePart, error) {
	header := files[name]
	switch {
	case name != "" && header == nil && fileID == "":
		if name == "file" {
			return nil, errBadRequest("send the file as the multipart part \"file\", or give file_id")
		}
		return nil, errBadRequest("there is no multipart part %q", name)
	case header != nil && fileID != "":
		return nil, errBadRequest("give either an uploaded file or file_id")
	case header == nil:
		if kind != "" {
			return nil, errBadRequest("kind goes with an uploaded file; a file_id keeps its kind")
		}
		if !media.ValidPublicID(fileID) {
			return nil, errBadRequest("file_id is invalid")
		}
		return nil, nil
	}
	k, ok := wire.MediaKindOf(kind)
	if !ok {
		return nil, errBadRequest("kind must be photo, video, audio, voice or document")
	}
	return &filePart{kind: k, header: header}, nil
}

// upload stores an uploaded part as the bot's file and returns its file_id.
func (s *Service) upload(ctx context.Context, bot *botadmin.Bot, p *filePart) (string, error) {
	if s.media == nil {
		return "", errMediaDisabled
	}
	f, err := p.header.Open()
	if err != nil {
		return "", errBadRequest("the uploaded file could not be read")
	}
	defer func() { _ = f.Close() }()
	stored, err := s.media.UploadStream(ctx, bot.ID, media.StreamUpload{
		Kind: p.kind, FileName: p.header.Filename, Body: f, MaxBytes: UploadBodyMax,
	})
	if err != nil {
		return "", err
	}
	return stored.PublicID, nil
}

var errMediaDisabled = &apiError{status: http.StatusBadRequest, code: "bad_request",
	description: "media_disabled: this server stores no files"}

// decodeMedia reads a JSON body into v, or a multipart/form-data body: its
// form fields (each once; the ones in jsonFields hold JSON) into v and its
// files by part name. cleanup removes the temporary files.
func decodeMedia(r *http.Request, v any, jsonFields []string) (map[string]*multipart.FileHeader, func(), error) {
	noop := func() {}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/form-data" {
		return nil, noop, decode(r, v, false)
	}
	r.Body = http.MaxBytesReader(nil, r.Body, UploadBodyMax)
	if err := r.ParseMultipartForm(formMemory); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, noop, &apiError{status: http.StatusRequestEntityTooLarge, code: "payload_too_large",
				description: fmt.Sprintf("a multipart body is at most %d MiB", UploadBodyMax>>20)}
		}
		return nil, noop, errBadRequest("invalid multipart body")
	}
	form := r.MultipartForm
	cleanup := func() { _ = form.RemoveAll() }
	fields := map[string]json.RawMessage{}
	for name, values := range form.Value {
		if len(values) != 1 {
			cleanup()
			return nil, noop, errBadRequest("the field %q is given %d times", name, len(values))
		}
		raw := []byte(values[0])
		if slices.Contains(jsonFields, name) {
			if !json.Valid(raw) {
				cleanup()
				return nil, noop, errBadRequest("the field %q must hold JSON", name)
			}
		} else {
			raw = []byte(strconv.Quote(values[0]))
		}
		fields[name] = raw
	}
	body, err := json.Marshal(fields)
	if err != nil {
		cleanup()
		return nil, noop, err
	}
	if err := strictJSON(body, v); err != nil {
		cleanup()
		return nil, noop, err
	}
	files := map[string]*multipart.FileHeader{}
	for name, list := range form.File {
		if len(list) != 1 || name == "" {
			cleanup()
			return nil, noop, errBadRequest("the part %q holds %d files; send one file per part", name, len(list))
		}
		files[name] = list[0]
	}
	return files, cleanup, nil
}

// getFile returns a file the bot can see in a message (its own or one in a
// chat it is in) with a download URL valid for about an hour, bound to the
// bot and that message: deleting the message revokes it.
func (s *Service) getFile(ctx context.Context, r *http.Request, bot *botadmin.Bot) (any, error) {
	if s.media == nil {
		return nil, errMediaDisabled
	}
	id := r.PathValue("file_id")
	if !media.ValidPublicID(id) {
		return nil, errNotFound("file not found")
	}
	access, err := s.chat.FileAccess(ctx, bot.ID, id)
	if err != nil {
		return nil, err
	}
	url := s.media.SignURL(bot.ID, *access, appv1.MediaSizeType_MEDIA_SIZE_TYPE_UNSPECIFIED)
	f := access.File
	return wire.File{
		FileID: f.PublicID, Kind: wire.MediaKindName(f.Kind), MimeType: f.MIME, Size: f.Size, FileName: f.Name,
		Width: f.Width, Height: f.Height, Duration: f.DurationMS, URL: url.GetUrl(), URLExpires: url.GetExpiresAt(),
	}, nil
}
