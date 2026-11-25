package chatmcp

import (
	"context"
	"errors"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Files reach a chat in two steps: upload (start_media_upload, PUT the bytes
// to the returned URLs, complete_media_upload) gives a media_id, and
// send_media posts media ids. The tools run MediaService and
// SendMedia/SendAlbum like the app, so the size, quota, type and album rules
// are the app's; the bytes go to the media host's signed URLs, never through
// a tool call.

type sendMediaInput struct {
	ChatID     int64    `json:"chat_id" jsonschema:"the chat to post in"`
	MediaIDs   []string `json:"media_ids" jsonschema:"media ids (file_id) from complete_media_upload, from start_media_upload's existing file, or of a file in a message the user can see; one sends a single message, 2 or more one album (photos and videos mixed, or only documents, or only audio)"`
	Caption    string   `json:"caption,omitempty" jsonschema:"text under the media (under the first item of an album)"`
	ReplyToSeq int64    `json:"reply_to_seq,omitempty" jsonschema:"seq of the message this replies to"`
	TopicID    int64    `json:"topic_id,omitempty" jsonschema:"forum groups: topic to post in; 0 for General"`
	Silent     bool     `json:"silent,omitempty" jsonschema:"deliver without a notification sound"`
}

type startUploadInput struct {
	Kind     string `json:"kind,omitempty" jsonschema:"photo (shown inline, at most 20 MB), video, audio, voice or document (any file, sent as is)"`
	FileName string `json:"file_name,omitempty" jsonschema:"name shown with the file"`
	MimeType string `json:"mime_type,omitempty" jsonschema:"declared MIME type; the server checks the content itself"`
	Size     int64  `json:"size,omitempty" jsonschema:"exact size in bytes"`
	FileHash string `json:"file_hash,omitempty" jsonschema:"hex SHA-256 of the whole file"`
	UploadID string `json:"upload_id,omitempty" jsonschema:"set only to get fresh URLs for an unfinished upload (all other fields are then ignored)"`
}

type uploadedPart struct {
	PartNumber int32  `json:"part_number" jsonschema:"the part"`
	ETag       string `json:"etag" jsonschema:"the ETag header of the part's PUT response"`
}

type completeUploadInput struct {
	UploadID string         `json:"upload_id" jsonschema:"from start_media_upload"`
	Parts    []uploadedPart `json:"parts" jsonschema:"every part with the ETag its PUT answered (the storage may not list parts, so a missing one fails with upload_incomplete)"`
}

func mediaTools() []toolDef {
	return []toolDef{
		{"send_media", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "send_media", Description: "Send photos, videos or files already stored in Chat as the user: one media id posts one message, several post one album. Everyone in the chat sees it as sent by the user.", Annotations: additive},
				func(ctx context.Context, in sendMediaInput) (any, error) {
					return sendMedia(ctx, t, in)
				})
		}},
		{"start_media_upload", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "start_media_upload", Description: "Start uploading a file to Chat. Answers either existing (the user already stored this file: use its file_id) or upload: PUT bytes [(part_number-1)*part_size, part_number*part_size) of the file to each part's url, with no auth header, before urls_expire_at, and keep the ETag header of each answer; then call complete_media_upload with those ETags.", Annotations: additive},
				func(ctx context.Context, in startUploadInput) (any, error) {
					req := &appv1.CreateUploadRequest{UploadId: in.UploadID}
					if in.UploadID == "" {
						kind := media.KindOf(in.Kind)
						if kind == appv1.MediaKind_MEDIA_KIND_UNSPECIFIED {
							return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("kind must be photo, video, audio, voice or document"))
						}
						req = &appv1.CreateUploadRequest{Kind: kind, FileName: in.FileName, MimeType: in.MimeType, Size: in.Size, FileHash: in.FileHash}
					}
					return call(ctx, t, t.h.cfg.Services.Media.CreateUpload, req)
				})
		}},
		{"complete_media_upload", ScopeChatWrite, func(s *mcp.Server, t *toolset) {
			addTool(s, t, &mcp.Tool{Name: "complete_media_upload", Description: "Finish an upload once every part is PUT, with the ETag of each; the server checks the content and answers the stored media (its file_id goes to send_media).", Annotations: additive},
				func(ctx context.Context, in completeUploadInput) (any, error) {
					parts := make([]*appv1.CompletedPart, len(in.Parts))
					for i, p := range in.Parts {
						parts[i] = &appv1.CompletedPart{PartNumber: p.PartNumber, Etag: p.ETag}
					}
					return call(ctx, t, t.h.cfg.Services.Media.CompleteUpload, &appv1.CompleteUploadRequest{UploadId: in.UploadID, Parts: parts})
				})
		}},
	}
}

// sendMedia posts one media id with SendMedia, or several as an album with
// SendAlbum.
func sendMedia(ctx context.Context, t *toolset, in sendMediaInput) (any, error) {
	if len(in.MediaIDs) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("media_ids needs at least one media id"))
	}
	if len(in.MediaIDs) == 1 {
		id, err := randomID()
		if err != nil {
			return nil, err
		}
		return call(ctx, t, t.h.cfg.Services.Messages.SendMedia, &appv1.SendMediaRequest{
			ChatId: in.ChatID, FileId: in.MediaIDs[0], Text: in.Caption, ReplyToSeq: in.ReplyToSeq, TopicId: in.TopicID,
			Silent: in.Silent, RandomId: id,
		})
	}
	items := make([]*appv1.AlbumItem, len(in.MediaIDs))
	for i, fileID := range in.MediaIDs {
		id, err := randomID()
		if err != nil {
			return nil, err
		}
		items[i] = &appv1.AlbumItem{FileId: fileID, RandomId: id}
	}
	items[0].Text = in.Caption
	return call(ctx, t, t.h.cfg.Services.Messages.SendAlbum, &appv1.SendAlbumRequest{
		ChatId: in.ChatID, Items: items, ReplyToSeq: in.ReplyToSeq, TopicId: in.TopicID, Silent: in.Silent,
	})
}
