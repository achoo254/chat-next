package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	appv1 "app.local/server/gen/app/v1"
)

// rewriteBlock is the block size of rewritten objects: blocks with a patch
// are read and uploaded, the others copied inside the storage.
const rewriteBlock = 16 << 20

var sizeSuffix = map[appv1.MediaSizeType]string{
	appv1.MediaSizeType_MEDIA_SIZE_TYPE_S: ".s",
	appv1.MediaSizeType_MEDIA_SIZE_TYPE_M: ".m",
	appv1.MediaSizeType_MEDIA_SIZE_TYPE_X: ".x",
}

func marshalSizes(sizes []Rendition) ([]byte, error) {
	if sizes == nil {
		sizes = []Rendition{}
	}
	b, err := json.Marshal(sizes)
	if err != nil {
		return nil, fmt.Errorf("media: encode sizes: %w", err)
	}
	return b, nil
}

func (s *Service) readAll(ctx context.Context, key string, offset, length int64) ([]byte, error) {
	body, err := s.objects.Get(ctx, key, offset, length)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	limit := length
	if limit < 0 {
		limit = PhotoMaxBytes + 1
	}
	b, err := io.ReadAll(io.LimitReader(body, limit))
	if err != nil {
		return nil, fmt.Errorf("media: read object: %w", err)
	}
	return b, nil
}

// process turns the staging object into the stored file f: it sets the
// type, size, hash and layout fields of f and writes f.Key (and its
// renditions). It reports whether the worker has more to do.
func (s *Service) process(ctx context.Context, staging string, size int64, f *File) (bool, error) {
	head, err := s.readAll(ctx, staging, 0, min(size, sniffLen))
	if err != nil {
		return false, errUnavailable(err)
	}
	mime := Sniff(head)
	if !kindAccepts(f.Kind, mime) {
		return false, refuse("the content (%s) is not a %s", mime, kindNames[f.Kind])
	}
	f.MIME = servedType(f.Kind, mime)
	f.Size = size
	switch {
	case isRasterImage(mime) && size <= PhotoMaxBytes:
		return false, s.processImage(ctx, staging, size, mime, f)
	case isMP4Family(mime):
		return s.processMP4(ctx, staging, size, f)
	}
	if err := s.objects.Copy(ctx, staging, f.Key); err != nil {
		return false, errUnavailable(err)
	}
	if !inlineSafe(f.MIME) {
		f.MIME = attachmentType(mime)
	}
	return s.wantsJob(f), nil
}

// attachmentType keeps recognized document types; the rest is binary.
func attachmentType(mime string) string {
	switch mime {
	case mimePDF, mimeZIP, mimeGzip, mimeHEIC, mimeAVIF, mimeMatroska:
		return mime
	}
	return mimeBinary
}

// wantsJob reports whether the worker (ffmpeg) can add something.
func (s *Service) wantsJob(f *File) bool {
	if s.cfg.FFmpegPath == "" || ffmpegFormat(f.MIME) == "" {
		return false
	}
	switch f.Kind {
	case appv1.MediaKind_MEDIA_KIND_VIDEO, appv1.MediaKind_MEDIA_KIND_VOICE:
		return true
	case appv1.MediaKind_MEDIA_KIND_AUDIO:
		return f.DurationMS == 0
	default:
		return false
	}
}

// processImage strips the image, checks its dimensions, and makes the
// renditions and inline thumb (photos: S, M, X; image documents: S).
func (s *Service) processImage(ctx context.Context, staging string, size int64, mime string, f *File) error {
	data, err := s.readAll(ctx, staging, 0, size)
	if err != nil {
		return errUnavailable(err)
	}
	photo := f.Kind == appv1.MediaKind_MEDIA_KIND_PHOTO
	stripped, orientation, err := stripImage(mime, data)
	if err != nil {
		if photo {
			return refuse("the image is malformed")
		}
		// A document that only looks like an image: stored as sent,
		// served as an attachment.
		f.MIME = mimeBinary
		return s.store(ctx, f, data)
	}
	cfg, err := imageConfig(mime, stripped)
	switch {
	case errors.Is(err, errImageTooLarge) && photo:
		return refuse("the image is larger than %d pixels; send it as a file", maxImagePixels)
	case err != nil && photo:
		return refuse("the image cannot be decoded")
	case err != nil:
		f.MIME = mimeBinary
		return s.store(ctx, f, stripped)
	}
	f.Width, f.Height = int32(cfg.Width), int32(cfg.Height)
	if w, h := orientedSize(cfg.Width, cfg.Height, orientation); w > 0 {
		f.Width, f.Height = int32(w), int32(h)
	}
	maxType := appv1.MediaSizeType_MEDIA_SIZE_TYPE_X
	if !photo {
		maxType = appv1.MediaSizeType_MEDIA_SIZE_TYPE_S
	}
	img, err := s.decode.decode(ctx, mime, stripped)
	if err != nil {
		if ctx.Err() != nil {
			return errUnavailable(err)
		}
		// Animated WebP and other variants the decoder lacks: no
		// renditions, the client thumb stays.
		s.logger.Info("image without renditions", "mime", mime, "err", err)
		return s.store(ctx, f, stripped)
	}
	d, err := derive(img, orientation, maxType)
	if err != nil {
		return fmt.Errorf("media: renditions: %w", err)
	}
	if len(d.inlineThumb) > 0 {
		f.InlineThumb = d.inlineThumb
	}
	for _, r := range d.renditions {
		key := f.Key + sizeSuffix[r.typ]
		if err := s.objects.Put(ctx, key, r.data, mimeJPEG); err != nil {
			s.deleteObjects(context.WithoutCancel(ctx), f.keys())
			return errUnavailable(err)
		}
		f.Sizes = append(f.Sizes, Rendition{Type: r.typ, Width: int32(r.w), Height: int32(r.h), Size: int64(len(r.data)), Key: key})
	}
	if err := s.store(ctx, f, stripped); err != nil {
		s.deleteObjects(context.WithoutCancel(ctx), f.keys())
		return err
	}
	return nil
}

// store writes data as the file's object; the hash is of the stored bytes.
func (s *Service) store(ctx context.Context, f *File, data []byte) error {
	sum := sha256.Sum256(data)
	f.Hash = hex.EncodeToString(sum[:])
	f.Size = int64(len(data))
	if err := s.objects.Put(ctx, f.Key, data, f.MIME); err != nil {
		return errUnavailable(err)
	}
	return nil
}

// processMP4 blanks the metadata boxes of an MP4/QuickTime file while
// copying it to the file's key, and reads duration and dimensions.
func (s *Service) processMP4(ctx context.Context, staging string, size int64, f *File) (bool, error) {
	read := func(offset, n int64) ([]byte, error) {
		n = min(n, size-offset)
		if n <= 0 {
			return nil, nil
		}
		return s.readAll(ctx, staging, offset, n)
	}
	info, err := scanMP4(read, size)
	if err != nil {
		if !errors.Is(err, errMalformed) && !errors.Is(err, errNoMoov) && !errors.Is(err, errMoovTooLarge) {
			return false, errUnavailable(err) // reading the object failed
		}
		if f.Kind != appv1.MediaKind_MEDIA_KIND_DOCUMENT {
			return false, refuse("the video or audio file is malformed")
		}
		if err := s.objects.Copy(ctx, staging, f.Key); err != nil {
			return false, errUnavailable(err)
		}
		f.MIME = mimeBinary
		return false, nil
	}
	if err := s.rewrite(ctx, staging, f.Key, size, info.patches); err != nil {
		return false, err
	}
	if info.durationMS > 0 && info.durationMS <= durationMax {
		f.DurationMS = int32(info.durationMS)
	}
	if info.width > 0 && info.height > 0 && info.width <= dimensionMax && info.height <= dimensionMax {
		f.Width, f.Height = int32(info.width), int32(info.height)
	}
	return s.wantsJob(f), nil
}

// rewrite copies src to dst with patches applied. Small objects go through
// memory; larger ones are assembled as a multipart upload where blocks
// without a patch are copied inside the storage.
func (s *Service) rewrite(ctx context.Context, src, dst string, size int64, patches []patch) error {
	if len(patches) == 0 {
		if err := s.objects.Copy(ctx, src, dst); err != nil {
			return errUnavailable(err)
		}
		return nil
	}
	block := max(int64(rewriteBlock), (size+maxParts-1)/maxParts)
	apply := func(b []byte, start int64) { applyPatches(b, start, patches) }
	if size <= block {
		data, err := s.readAll(ctx, src, 0, size)
		if err != nil {
			return errUnavailable(err)
		}
		apply(data, 0)
		if err := s.objects.Put(ctx, dst, data, mimeBinary); err != nil {
			return errUnavailable(err)
		}
		return nil
	}
	uploadID, err := s.objects.CreateMultipart(ctx, dst)
	if err != nil {
		return errUnavailable(err)
	}
	var parts []Part
	fail := func(err error) error {
		if aerr := s.objects.AbortMultipart(context.WithoutCancel(ctx), dst, uploadID); aerr != nil {
			s.logger.Warn("aborting a rewrite failed", "err", aerr)
		}
		return errUnavailable(err)
	}
	for n, start := 1, int64(0); start < size; n, start = n+1, start+block {
		length := min(block, size-start)
		patched := false
		for _, p := range patches {
			if p.offset < start+length && p.end() > start {
				patched = true
			}
		}
		var part Part
		if patched {
			data, err := s.readAll(ctx, src, start, length)
			if err != nil {
				return fail(err)
			}
			apply(data, start)
			part, err = s.objects.UploadPart(ctx, dst, uploadID, n, bytes.NewReader(data), length)
			if err != nil {
				return fail(err)
			}
		} else if part, err = s.objects.CopyPart(ctx, src, dst, uploadID, n, start, length); err != nil {
			return fail(err)
		}
		parts = append(parts, part)
	}
	if err := s.objects.CompleteMultipart(ctx, dst, uploadID, parts); err != nil {
		return fail(err)
	}
	return nil
}

// applyPatches writes the patches into b, the object's bytes from start.
func applyPatches(b []byte, start int64, patches []patch) {
	end := start + int64(len(b))
	for _, p := range patches {
		for i, c := range p.data {
			if off := p.offset + int64(i) - start; off >= 0 && off < int64(len(b)) {
				b[off] = c
			}
		}
		from, to := max(p.offset+int64(len(p.data)), start), min(p.end(), end)
		if from < to {
			clear(b[from-start : to-start])
		}
	}
}
