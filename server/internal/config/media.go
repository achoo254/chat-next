package config

import (
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
)

// Defaults and bounds of the media variables.
const (
	// DefaultUploadMaxBytes matches AppConfig.upload_size_max_bytes of R1.
	DefaultUploadMaxBytes = 2000 << 20
	// UploadMaxBytesLimit keeps every stored object within one S3
	// CopyObject (5 GiB).
	UploadMaxBytesLimit   = 5 << 30
	DefaultUserQuotaBytes = 20 << 30
	DefaultS3Region       = "us-east-1"
	DefaultMediaRoot      = "/opt/chat/media"
	DefaultMinFreeBytes   = 5 << 30

	StorageFilesystem = "filesystem"
	StorageS3         = "s3"

	UploadDirect = "direct"
	UploadProxy  = "proxy"
)

// Media configures media storage and the media host. Media is on when
// MEDIA_PUBLIC_URL is set. Storage is a directory on this server
// (MEDIA_STORAGE=filesystem, the default) or S3-compatible object storage
// (MEDIA_STORAGE=s3, which needs MEDIA_S3_ENDPOINT, MEDIA_S3_BUCKET,
// S3_ACCESS_KEY and S3_SECRET_KEY).
type Media struct {
	Storage string
	// Root is the storage directory of the filesystem storage.
	Root string
	// MinFreeBytes: uploads are refused while the root's disk would keep
	// less free space (filesystem storage).
	MinFreeBytes int64

	// Endpoint is the S3 API origin the server talks to.
	Endpoint *url.URL
	// PublicEndpoint is the S3 origin browsers upload parts to (presigned
	// URLs are signed for it); defaults to Endpoint.
	PublicEndpoint *url.URL
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	// PathStyle addresses the bucket as <endpoint>/<bucket> (default; Ceph
	// RGW and MinIO) instead of <bucket>.<endpoint>.
	PathStyle bool
	// Prefix is prepended to every object key, e.g. "chat/" to share a
	// bucket.
	Prefix string

	// PublicURL is the media host origin download URLs point at, e.g.
	// https://media-chat.hoandat.com; never the app's host.
	PublicURL *url.URL
	// UploadMaxBytes bounds one file.
	UploadMaxBytes int64
	// UserQuotaBytes bounds what one user stores (files plus uploads in
	// progress).
	UserQuotaBytes int64
	// UploadMode is where browsers PUT upload parts: UploadProxy (the media
	// host receives each part; the only mode of the filesystem storage) or
	// UploadDirect (S3 only: presigned URLs on PublicEndpoint; the bucket
	// needs a CORS rule allowing PUT from the app origins and exposing
	// ETag).
	UploadMode string
	// FFmpegPath enables video posters and voice waveforms; empty disables
	// them (clients then provide thumbs, durations and waveforms).
	FFmpegPath string
}

var s3PrefixPattern = regexp.MustCompile(`^([a-z0-9][a-z0-9._-]{0,62}/){0,4}$`)

// PublicOrigin is the origin of MEDIA_PUBLIC_URL.
func (m *Media) PublicOrigin() string {
	return m.PublicURL.Scheme + "://" + m.PublicURL.Host
}

func loadMedia(get func(string) string, production bool, chatURL *url.URL) (*Media, []error) {
	rawPublic := get("MEDIA_PUBLIC_URL")
	if rawPublic == "" {
		return nil, nil
	}
	var errs []error
	m := &Media{
		Storage:        get("MEDIA_STORAGE"),
		Root:           get("MEDIA_ROOT"),
		MinFreeBytes:   DefaultMinFreeBytes,
		Region:         get("MEDIA_S3_REGION"),
		PathStyle:      true,
		Prefix:         get("MEDIA_S3_PREFIX"),
		UploadMaxBytes: DefaultUploadMaxBytes,
		UserQuotaBytes: DefaultUserQuotaBytes,
		UploadMode:     UploadProxy,
	}
	if m.Storage == "" {
		m.Storage = StorageFilesystem
	}
	if m.Root == "" {
		m.Root = DefaultMediaRoot
	}
	if m.Region == "" {
		m.Region = DefaultS3Region
	}
	u, err := parseOrigin(rawPublic)
	switch {
	case err != nil:
		errs = append(errs, invalid("MEDIA_PUBLIC_URL", err.Error()))
	case production && u.Scheme != "https":
		errs = append(errs, invalid("MEDIA_PUBLIC_URL", "must use https in production"))
	case chatURL != nil && u.Hostname() == chatURL.Hostname():
		errs = append(errs, invalid("MEDIA_PUBLIC_URL", "must be a different host than CHAT_PUBLIC_URL"))
	default:
		m.PublicURL = u
	}
	switch m.Storage {
	case StorageFilesystem:
		if !filepath.IsAbs(m.Root) || filepath.Clean(m.Root) == "/" {
			errs = append(errs, invalid("MEDIA_ROOT", "must be an absolute directory other than /"))
		}
		if raw := get("MEDIA_MIN_FREE_BYTES"); raw != "" {
			v, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || v < 0 {
				errs = append(errs, invalid("MEDIA_MIN_FREE_BYTES", "must be a byte count"))
			} else {
				m.MinFreeBytes = v
			}
		}
	case StorageS3:
		errs = append(errs, m.loadS3(get, production)...)
	default:
		errs = append(errs, invalid("MEDIA_STORAGE", "must be filesystem or s3"))
	}
	if raw := get("MEDIA_UPLOAD_MODE"); raw != "" {
		switch {
		case raw != UploadDirect && raw != UploadProxy:
			errs = append(errs, invalid("MEDIA_UPLOAD_MODE", "must be direct or proxy"))
		case raw == UploadDirect && m.Storage != StorageS3:
			errs = append(errs, invalid("MEDIA_UPLOAD_MODE", "direct needs MEDIA_STORAGE=s3"))
		default:
			m.UploadMode = raw
		}
	}
	if raw := get("MEDIA_UPLOAD_MAX_BYTES"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1<<20 || v > UploadMaxBytesLimit {
			errs = append(errs, invalid("MEDIA_UPLOAD_MAX_BYTES", "must be a byte count from 1 MiB to 5 GiB"))
		} else {
			m.UploadMaxBytes = v
		}
	}
	if raw := get("MEDIA_USER_QUOTA_BYTES"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1<<20 {
			errs = append(errs, invalid("MEDIA_USER_QUOTA_BYTES", "must be a byte count of at least 1 MiB"))
		} else {
			m.UserQuotaBytes = v
		}
	}
	if raw := get("MEDIA_FFMPEG_PATH"); raw != "" {
		if !filepath.IsAbs(raw) {
			errs = append(errs, invalid("MEDIA_FFMPEG_PATH", "must be an absolute path"))
		} else if _, err := exec.LookPath(raw); err != nil {
			errs = append(errs, invalid("MEDIA_FFMPEG_PATH", "is not an executable file"))
		} else {
			m.FFmpegPath = raw
		}
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return m, nil
}

// loadS3 reads the object storage variables.
func (m *Media) loadS3(get func(string) string, production bool) []error {
	var errs []error
	required := func(name string) string {
		v := get(name)
		if v == "" {
			errs = append(errs, missing(name))
		}
		return v
	}
	m.Bucket = required("MEDIA_S3_BUCKET")
	m.AccessKey = required("S3_ACCESS_KEY")
	m.SecretKey = required("S3_SECRET_KEY")
	if raw := required("MEDIA_S3_ENDPOINT"); raw != "" {
		endpoint, err := parseOrigin(raw)
		switch {
		case err != nil:
			errs = append(errs, invalid("MEDIA_S3_ENDPOINT", err.Error()))
		case production && endpoint.Scheme != "https":
			errs = append(errs, invalid("MEDIA_S3_ENDPOINT", "must use https in production"))
		default:
			m.Endpoint = endpoint
			m.PublicEndpoint = endpoint
		}
	}
	if raw := get("MEDIA_S3_PUBLIC_ENDPOINT"); raw != "" {
		u, err := parseOrigin(raw)
		switch {
		case err != nil:
			errs = append(errs, invalid("MEDIA_S3_PUBLIC_ENDPOINT", err.Error()))
		case production && u.Scheme != "https":
			errs = append(errs, invalid("MEDIA_S3_PUBLIC_ENDPOINT", "must use https in production"))
		default:
			m.PublicEndpoint = u
		}
	}
	if m.Bucket != "" && !bucketPattern.MatchString(m.Bucket) {
		errs = append(errs, invalid("MEDIA_S3_BUCKET", "must be an S3 bucket name"))
	}
	if raw := get("MEDIA_S3_PATH_STYLE"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			errs = append(errs, invalid("MEDIA_S3_PATH_STYLE", "must be true or false"))
		}
		m.PathStyle = v
	}
	if m.Prefix != "" && !s3PrefixPattern.MatchString(m.Prefix) {
		errs = append(errs, invalid("MEDIA_S3_PREFIX", "must be lowercase path segments ending with /, like chat/"))
	}
	return errs
}

var bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
