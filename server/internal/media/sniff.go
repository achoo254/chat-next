package media

import (
	"bytes"
	"encoding/binary"
	"slices"

	appv1 "app.local/server/gen/app/v1"
)

// sniffLen is how many leading bytes Sniff looks at.
const sniffLen = 4096

// Content types the server recognizes from magic bytes. Anything else is
// served as application/octet-stream, always as an attachment.
const (
	mimeJPEG      = "image/jpeg"
	mimePNG       = "image/png"
	mimeGIF       = "image/gif"
	mimeWebP      = "image/webp"
	mimeHEIC      = "image/heic"
	mimeAVIF      = "image/avif"
	mimeMP4       = "video/mp4"
	mimeQuickTime = "video/quicktime"
	mimeWebM      = "video/webm"
	mimeMatroska  = "video/x-matroska"
	mimeAudioMP4  = "audio/mp4"
	mimeAudioWebM = "audio/webm"
	mimeOgg       = "audio/ogg"
	mimeMPEG      = "audio/mpeg"
	mimeAAC       = "audio/aac"
	mimeWAV       = "audio/wav"
	mimeFLAC      = "audio/flac"
	mimePDF       = "application/pdf"
	mimeZIP       = "application/zip"
	mimeGzip      = "application/gzip"
	mimeBinary    = "application/octet-stream"
)

// Sniff returns the content type of a file from its first bytes. It never
// returns a type a browser would render as a document (HTML, SVG, XML).
func Sniff(head []byte) string {
	b := head[:min(len(head), sniffLen)]
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return mimeJPEG
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return mimePNG
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return mimeGIF
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return mimeWebP
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE")):
		return mimeWAV
	case len(b) >= 12 && bytes.Equal(b[4:8], []byte("ftyp")):
		return sniffFtyp(b)
	case bytes.HasPrefix(b, []byte("\x1a\x45\xdf\xa3")):
		head := b[:min(len(b), 64)]
		switch {
		case bytes.Contains(head, []byte("webm")):
			return mimeWebM
		case bytes.Contains(head, []byte("matroska")):
			return mimeMatroska
		}
		return mimeBinary
	case bytes.HasPrefix(b, []byte("OggS")):
		return mimeOgg
	case bytes.HasPrefix(b, []byte("fLaC")):
		return mimeFLAC
	case bytes.HasPrefix(b, []byte("ID3")):
		return mimeMPEG
	case len(b) >= 2 && b[0] == 0xFF && (b[1] == 0xF1 || b[1] == 0xF9):
		return mimeAAC
	case len(b) >= 2 && b[0] == 0xFF && b[1]&0xE0 == 0xE0 && b[1]&0x06 != 0:
		return mimeMPEG
	case bytes.HasPrefix(b, []byte("%PDF-")):
		return mimePDF
	case bytes.HasPrefix(b, []byte("PK\x03\x04")):
		return mimeZIP
	case bytes.HasPrefix(b, []byte("\x1f\x8b")):
		return mimeGzip
	}
	return mimeBinary
}

var (
	quickTimeBrands = []string{"qt  "}
	audioMP4Brands  = []string{"M4A ", "M4B ", "M4P "}
	heicBrands      = []string{"heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"}
	avifBrands      = []string{"avif", "avis"}
	mp4Brands       = []string{"isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "3gp4",
		"3gp5", "3gp6", "3g2a", "M4V ", "M4VH", "M4VP", "mmp4", "MSNV", "f4v "}
)

// sniffFtyp classifies an ISO base media file by its major brand, then by
// its compatible brands.
func sniffFtyp(b []byte) string {
	size := int(binary.BigEndian.Uint32(b[:4]))
	if size < 16 || size > len(b) {
		size = min(len(b), 64)
	}
	brands := []string{string(b[8:12])}
	for i := 16; i+4 <= size; i += 4 {
		brands = append(brands, string(b[i:i+4]))
	}
	for _, brand := range brands {
		switch {
		case slices.Contains(quickTimeBrands, brand):
			return mimeQuickTime
		case slices.Contains(audioMP4Brands, brand):
			return mimeAudioMP4
		case slices.Contains(avifBrands, brand):
			return mimeAVIF
		case slices.Contains(heicBrands, brand):
			return mimeHEIC
		case slices.Contains(mp4Brands, brand):
			return mimeMP4
		}
	}
	return mimeBinary
}

// kindAccepts reports whether content of type mime may be sent as kind.
func kindAccepts(kind appv1.MediaKind, mime string) bool {
	switch kind {
	case appv1.MediaKind_MEDIA_KIND_PHOTO:
		return isRasterImage(mime)
	case appv1.MediaKind_MEDIA_KIND_VIDEO:
		return mime == mimeMP4 || mime == mimeQuickTime || mime == mimeWebM
	case appv1.MediaKind_MEDIA_KIND_VOICE:
		return slices.Contains([]string{mimeOgg, mimeWebM, mimeMP4, mimeAudioMP4, mimeMPEG, mimeAAC}, mime)
	case appv1.MediaKind_MEDIA_KIND_AUDIO:
		return slices.Contains([]string{mimeOgg, mimeWebM, mimeMP4, mimeAudioMP4, mimeMPEG, mimeAAC, mimeWAV, mimeFLAC}, mime)
	case appv1.MediaKind_MEDIA_KIND_DOCUMENT:
		return true
	default:
		return false
	}
}

// servedType is the Content-Type a file of kind is served with: audio
// kinds in a video container are audio.
func servedType(kind appv1.MediaKind, mime string) string {
	if kind == appv1.MediaKind_MEDIA_KIND_VOICE || kind == appv1.MediaKind_MEDIA_KIND_AUDIO {
		switch mime {
		case mimeWebM:
			return mimeAudioWebM
		case mimeMP4:
			return mimeAudioMP4
		}
	}
	return mime
}

func isRasterImage(mime string) bool {
	return mime == mimeJPEG || mime == mimePNG || mime == mimeGIF || mime == mimeWebP
}

// isMP4Family is content in an ISO base media (MP4/QuickTime) container.
func isMP4Family(mime string) bool {
	return mime == mimeMP4 || mime == mimeQuickTime || mime == mimeAudioMP4
}

// inlineSafe reports types a browser may show inline from the media host;
// everything else is served as an attachment.
func inlineSafe(mime string) bool {
	switch mime {
	case mimeJPEG, mimePNG, mimeGIF, mimeWebP, mimeMP4, mimeQuickTime, mimeWebM,
		mimeAudioMP4, mimeAudioWebM, mimeOgg, mimeMPEG, mimeAAC, mimeWAV, mimeFLAC:
		return true
	}
	return false
}
