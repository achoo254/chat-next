package rpc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// configService implements ConfigService with the static limits of this
// release; per-tenant values come later.
type configService struct {
	appv1connect.UnimplementedConfigServiceHandler
	config *appv1.AppConfig
}

const (
	mib = 1 << 20
	gib = 1 << 30
)

// newAppConfig returns the static configuration with its hash: SHA-256 of
// the deterministic encoding of every other field.
func newAppConfig() (*appv1.AppConfig, error) {
	c := &appv1.AppConfig{
		MessageLengthMax:          4096,
		CaptionLengthMax:          1024,
		EditTimeLimitSeconds:      48 * 3600,
		ReadReceiptsMemberMax:     100,
		ReadReceiptsMaxAgeSeconds: 7 * 24 * 3600,
		DesktopNotifyDelayMs:      1500,
		MediaCacheSizeBytes:       2 * gib,
		MediaCacheMaxAgeSeconds:   30 * 24 * 3600,
		MediaCacheLargeFilesBytes: 1 * gib,
		UploadSizeMaxBytes:        2000 * mib,
		AlbumSizeMax:              10,
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	if err != nil {
		return nil, fmt.Errorf("rpc: app config hash: %w", err)
	}
	sum := sha256.Sum256(b)
	c.Hash = hex.EncodeToString(sum[:16])
	return c, nil
}

// GetAppConfig returns not_modified when the client already holds the
// current hash.
func (s *configService) GetAppConfig(_ context.Context, req *connect.Request[appv1.GetAppConfigRequest]) (*connect.Response[appv1.GetAppConfigResponse], error) {
	if req.Msg.GetHash() == s.config.GetHash() {
		return connect.NewResponse(&appv1.GetAppConfigResponse{
			Result: &appv1.GetAppConfigResponse_NotModified{NotModified: &appv1.AppConfigNotModified{}},
		}), nil
	}
	return connect.NewResponse(&appv1.GetAppConfigResponse{
		Result: &appv1.GetAppConfigResponse_Config{Config: s.config},
	}), nil
}
