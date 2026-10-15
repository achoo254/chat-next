package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Part is one uploaded part of a multipart upload.
type Part struct {
	Number int
	ETag   string
	Size   int64
}

// Objects is the S3-compatible object storage the media service uses. Every
// key is relative to the configured prefix. The production identity may
// only get, put, delete and abort multipart uploads (no bucket
// configuration, no listing of multipart uploads or parts), so nothing here
// depends on more than that, except the best-effort listings.
type Objects interface {
	CreateMultipart(ctx context.Context, key string) (uploadID string, err error)
	// PresignPart signs a PUT of one part for a browser.
	PresignPart(ctx context.Context, key, uploadID string, part int, ttl time.Duration) (string, error)
	// UploadPart stores one part sent through the server (proxy uploads,
	// rewritten objects).
	UploadPart(ctx context.Context, key, uploadID string, part int, body io.Reader, size int64) (Part, error)
	// CopyPart copies length bytes of src from offset into one part.
	CopyPart(ctx context.Context, src, key, uploadID string, part int, offset, length int64) (Part, error)
	// ListParts lists stored parts; it may fail where the identity lacks the
	// permission, so callers treat it as a hint.
	ListParts(ctx context.Context, key, uploadID string) ([]Part, error)
	CompleteMultipart(ctx context.Context, key, uploadID string, parts []Part) error
	AbortMultipart(ctx context.Context, key, uploadID string) error
	// Get reads length bytes from offset; length < 0 reads to the end.
	Get(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
	// PresignGet signs a GET for a local tool (ffmpeg).
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	Size(ctx context.Context, key string) (int64, error)
	Put(ctx context.Context, key string, data []byte, contentType string) error
	Copy(ctx context.Context, src, dst string) error
	Delete(ctx context.Context, key string) error
	// Ping checks that the bucket answers.
	Ping(ctx context.Context) error
}

// ErrNotFound reports a missing object or upload.
var ErrNotFound = errors.New("media: object not found")

// S3Config locates the bucket.
type S3Config struct {
	Endpoint       *url.URL
	PublicEndpoint *url.URL
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	PathStyle      bool
	Prefix         string
}

// S3 implements Objects with minio-go on any S3-compatible service.
type S3 struct {
	core   minio.Core
	public *minio.Client
	bucket string
	prefix string
}

// NewS3 returns the store; it does not contact the service.
func NewS3(c S3Config) (*S3, error) {
	client := func(u *url.URL) (*minio.Client, error) {
		lookup := minio.BucketLookupDNS
		if c.PathStyle {
			lookup = minio.BucketLookupPath
		}
		return minio.New(u.Host, &minio.Options{
			Creds:        credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
			Secure:       u.Scheme == "https",
			Region:       c.Region,
			BucketLookup: lookup,
		})
	}
	main, err := client(c.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("media: s3 client: %w", err)
	}
	public := main
	if c.PublicEndpoint != nil && c.PublicEndpoint.String() != c.Endpoint.String() {
		if public, err = client(c.PublicEndpoint); err != nil {
			return nil, fmt.Errorf("media: s3 public client: %w", err)
		}
	}
	return &S3{core: minio.Core{Client: main}, public: public, bucket: c.Bucket, prefix: c.Prefix}, nil
}

func (s *S3) key(k string) string { return s.prefix + k }

func mapErr(op string, err error) error {
	if err == nil {
		return nil
	}
	resp := minio.ToErrorResponse(err)
	if resp.StatusCode == http.StatusNotFound || resp.Code == "NoSuchKey" || resp.Code == "NoSuchUpload" {
		return fmt.Errorf("media: %s: %w", op, ErrNotFound)
	}
	return fmt.Errorf("media: %s: %w", op, err)
}

func (s *S3) CreateMultipart(ctx context.Context, key string) (string, error) {
	id, err := s.core.NewMultipartUpload(ctx, s.bucket, s.key(key), minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return id, mapErr("create multipart", err)
}

func (s *S3) PresignPart(ctx context.Context, key, uploadID string, part int, ttl time.Duration) (string, error) {
	q := url.Values{"partNumber": {strconv.Itoa(part)}, "uploadId": {uploadID}}
	u, err := s.public.Presign(ctx, http.MethodPut, s.bucket, s.key(key), ttl, q)
	if err != nil {
		return "", mapErr("presign part", err)
	}
	return u.String(), nil
}

func (s *S3) UploadPart(ctx context.Context, key, uploadID string, part int, body io.Reader, size int64) (Part, error) {
	p, err := s.core.PutObjectPart(ctx, s.bucket, s.key(key), uploadID, part, body, size, minio.PutObjectPartOptions{})
	if err != nil {
		return Part{}, mapErr("upload part", err)
	}
	return Part{Number: part, ETag: p.ETag, Size: p.Size}, nil
}

func (s *S3) CopyPart(ctx context.Context, src, key, uploadID string, part int, offset, length int64) (Part, error) {
	p, err := s.core.CopyObjectPart(ctx, s.bucket, s.key(src), s.bucket, s.key(key), uploadID, part, offset, length, nil)
	if err != nil {
		return Part{}, mapErr("copy part", err)
	}
	return Part{Number: part, ETag: p.ETag, Size: length}, nil
}

func (s *S3) ListParts(ctx context.Context, key, uploadID string) ([]Part, error) {
	var out []Part
	marker := 0
	for {
		res, err := s.core.ListObjectParts(ctx, s.bucket, s.key(key), uploadID, marker, 1000)
		if err != nil {
			return nil, mapErr("list parts", err)
		}
		for _, p := range res.ObjectParts {
			out = append(out, Part{Number: p.PartNumber, ETag: p.ETag, Size: p.Size})
		}
		if !res.IsTruncated {
			return out, nil
		}
		marker = res.NextPartNumberMarker
	}
}

func (s *S3) CompleteMultipart(ctx context.Context, key, uploadID string, parts []Part) error {
	list := make([]minio.CompletePart, len(parts))
	for i, p := range parts {
		list[i] = minio.CompletePart{PartNumber: p.Number, ETag: p.ETag}
	}
	_, err := s.core.CompleteMultipartUpload(ctx, s.bucket, s.key(key), uploadID, list, minio.PutObjectOptions{})
	return mapErr("complete multipart", err)
}

func (s *S3) AbortMultipart(ctx context.Context, key, uploadID string) error {
	return mapErr("abort multipart", s.core.AbortMultipartUpload(ctx, s.bucket, s.key(key), uploadID))
}

func (s *S3) Get(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	opts := minio.GetObjectOptions{}
	if offset > 0 || length >= 0 {
		end := int64(0)
		if length >= 0 {
			end = offset + length - 1
		}
		if err := opts.SetRange(offset, end); err != nil {
			return nil, fmt.Errorf("media: get range: %w", err)
		}
	}
	body, _, _, err := s.core.GetObject(ctx, s.bucket, s.key(key), opts)
	if err != nil {
		return nil, mapErr("get", err)
	}
	return body, nil
}

func (s *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.core.PresignedGetObject(ctx, s.bucket, s.key(key), ttl, nil)
	if err != nil {
		return "", mapErr("presign get", err)
	}
	return u.String(), nil
}

func (s *S3) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.core.StatObject(ctx, s.bucket, s.key(key), minio.StatObjectOptions{})
	if err != nil {
		return 0, mapErr("stat", err)
	}
	return info.Size, nil
}

func (s *S3) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := s.core.PutObject(ctx, s.bucket, s.key(key), bytes.NewReader(data), int64(len(data)), "", "",
		minio.PutObjectOptions{ContentType: contentType})
	return mapErr("put", err)
}

func (s *S3) Copy(ctx context.Context, src, dst string) error {
	_, err := s.core.CopyObject(ctx, s.bucket, s.key(src), s.bucket, s.key(dst), nil,
		minio.CopySrcOptions{}, minio.PutObjectOptions{})
	return mapErr("copy", err)
}

func (s *S3) Delete(ctx context.Context, key string) error {
	err := s.core.RemoveObject(ctx, s.bucket, s.key(key), minio.RemoveObjectOptions{})
	if errors.Is(mapErr("delete", err), ErrNotFound) {
		return nil
	}
	return mapErr("delete", err)
}

func (s *S3) Ping(ctx context.Context) error {
	ok, err := s.core.BucketExists(ctx, s.bucket)
	if err != nil {
		return mapErr("ping", err)
	}
	if !ok {
		return fmt.Errorf("media: bucket %q does not exist", s.bucket)
	}
	return nil
}
