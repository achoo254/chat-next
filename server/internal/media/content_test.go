package media

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

func TestSniff(t *testing.T) {
	cases := map[string]string{
		"\xFF\xD8\xFF\xE0":                                                 mimeJPEG,
		"\x89PNG\r\n\x1a\nxxxx":                                            mimePNG,
		"GIF89a....":                                                       mimeGIF,
		"RIFF\x00\x00\x00\x00WEBPVP8 ":                                     mimeWebP,
		"RIFF\x00\x00\x00\x00WAVEfmt ":                                     mimeWAV,
		"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ":                     mimeQuickTime,
		"\x00\x00\x00\x14ftypM4A \x00\x00\x00\x00M4A ":                     mimeAudioMP4,
		"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2":                 mimeMP4,
		"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic":                 mimeHEIC,
		"\x1a\x45\xdf\xa3\x01\x00\x00\x00\x00\x00\x00\x1f\x42\x82\x84webm": mimeWebM,
		"OggS\x00\x02":                                                     mimeOgg,
		"ID3\x03\x00":                                                      mimeMPEG,
		"%PDF-1.7":                                                         mimePDF,
		"<!DOCTYPE html><html><script>":                                    mimeBinary,
		"<svg xmlns='http://www.w3.org/2000/svg'":                          mimeBinary,
		"<?xml version='1.0'?>":                                            mimeBinary,
		"plain text":                                                       mimeBinary,
	}
	for in, want := range cases {
		if got := Sniff([]byte(in)); got != want {
			t.Errorf("Sniff(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestKindAcceptsRejectsSpoofing(t *testing.T) {
	if kindAccepts(appv1.MediaKind_MEDIA_KIND_PHOTO, mimeBinary) || kindAccepts(appv1.MediaKind_MEDIA_KIND_PHOTO, mimePDF) ||
		kindAccepts(appv1.MediaKind_MEDIA_KIND_VIDEO, mimeJPEG) || kindAccepts(appv1.MediaKind_MEDIA_KIND_VOICE, mimePNG) {
		t.Fatal("a kind accepted foreign content")
	}
	if !kindAccepts(appv1.MediaKind_MEDIA_KIND_DOCUMENT, mimeBinary) || !kindAccepts(appv1.MediaKind_MEDIA_KIND_PHOTO, mimeWebP) {
		t.Fatal("a kind refused its own content")
	}
	if inlineSafe(mimeBinary) || inlineSafe(mimePDF) || !inlineSafe(mimeJPEG) {
		t.Fatal("inline policy wrong")
	}
	if servedType(appv1.MediaKind_MEDIA_KIND_VOICE, mimeWebM) != mimeAudioWebM {
		t.Fatal("voice in webm must be served as audio")
	}
}

func TestStripJPEGKeepsOnlyOrientation(t *testing.T) {
	in := jpegWithExif(t, 64, 32, 6)
	out, orientation, err := stripImage(mimeJPEG, in)
	if err != nil {
		t.Fatal(err)
	}
	if orientation != 6 {
		t.Fatalf("orientation = %d", orientation)
	}
	if bytes.Contains(out, []byte(gpsMarker)) || bytes.Contains(out, []byte("xmpmeta")) {
		t.Fatal("metadata survived")
	}
	if !bytes.HasSuffix(out, []byte{0xFF, 0xD9}) {
		t.Fatal("data after EOI survived")
	}
	if got := exifOrientation(out[bytes.Index(out, []byte("Exif\x00\x00"))+6:]); got != 6 {
		t.Fatalf("orientation block = %d", got)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil || img.Bounds().Dx() != 64 {
		t.Fatalf("stripped JPEG does not decode: %v", err)
	}
	// Orientation 1: no EXIF block at all.
	out, _, err = stripImage(mimeJPEG, jpegWithExif(t, 8, 8, 1))
	if err != nil || bytes.Contains(out, []byte("Exif")) {
		t.Fatalf("orientation 1 kept EXIF: %v", err)
	}
}

func TestStripPNGWebPGIF(t *testing.T) {
	out, _, err := stripImage(mimePNG, pngWithText(t, 10, 10))
	if err != nil || bytes.Contains(out, []byte(gpsMarker)) {
		t.Fatalf("png: %v", err)
	}
	if _, err := imageConfig(mimePNG, out); err != nil {
		t.Fatalf("stripped png: %v", err)
	}
	// WebP with an EXIF chunk and the EXIF flag set.
	vp8x := append([]byte("VP8X"), 10, 0, 0, 0, 0x08, 0, 0, 0, 9, 0, 0, 9, 0, 0)
	exif := append([]byte("EXIF"), byte(len(gpsMarker)), 0, 0, 0)
	exif = append(exif, gpsMarker...)
	if len(gpsMarker)%2 == 1 {
		exif = append(exif, 0)
	}
	body := append(append([]byte("WEBP"), vp8x...), exif...)
	webp := append([]byte("RIFF"), byte(len(body)), 0, 0, 0)
	webp = append(webp, body...)
	out, err = stripWebP(webp)
	if err != nil || bytes.Contains(out, []byte(gpsMarker)) || out[20]&0x08 != 0 {
		t.Fatalf("webp: %v %x", err, out)
	}
	if int(out[4])+8 != len(out) {
		t.Fatal("webp RIFF size not updated")
	}
	// GIF with a comment extension.
	gif := []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00")
	gif = append(gif, 0x21, 0xFE, byte(len(gpsMarker)))
	gif = append(gif, gpsMarker...)
	gif = append(gif, 0, 0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4C, 0x01, 0, 0x3B)
	gif = append(gif, "after trailer"...)
	out, err = stripGIF(gif)
	if err != nil || bytes.Contains(out, []byte(gpsMarker)) || out[len(out)-1] != 0x3B {
		t.Fatalf("gif: %v %q", err, out)
	}
	if _, _, err := stripImage(mimeJPEG, []byte("\xFF\xD8\xFF\xE1\x00")); !errors.Is(err, errMalformed) {
		t.Fatalf("truncated jpeg: %v", err)
	}
}

func TestScanMP4BlanksMetadata(t *testing.T) {
	data := testMP4(1000)
	read := func(off, n int64) ([]byte, error) {
		end := min(off+n, int64(len(data)))
		return bytes.Clone(data[off:end]), nil
	}
	info, err := scanMP4(read, int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if info.durationMS != 12500 || info.width != 1080 || info.height != 1920 {
		t.Fatalf("info = %+v", info)
	}
	out := bytes.Clone(data)
	applyPatches(out, 0, info.patches)
	if bytes.Contains(out, []byte("udta")) || bytes.Contains(out, []byte("meta")) || len(out) != len(data) {
		t.Fatalf("metadata boxes left: %d patches", len(info.patches))
	}
	// The boxes' contents go too, not only their names.
	if bytes.Contains(out, []byte(gpsMarker)) || bytes.Contains(out, []byte("location")) {
		t.Fatal("metadata contents left in the movie")
	}
	// Still a valid movie: the same scan finds the same facts, no metadata left to blank.
	again, err := scanMP4(func(off, n int64) ([]byte, error) { return bytes.Clone(out[off:min(off+n, int64(len(out)))]), nil }, int64(len(out)))
	if err != nil || again.durationMS != 12500 || again.width != 1080 || len(again.patches) != 0 {
		t.Fatalf("rescan = %+v, %v", again, err)
	}
	// Patches applied block by block give the same bytes.
	blocks := bytes.Clone(data)
	for start := 0; start < len(blocks); start += 37 {
		applyPatches(blocks[start:min(start+37, len(blocks))], int64(start), info.patches)
	}
	if !bytes.Equal(blocks, out) {
		t.Fatal("blockwise patching differs")
	}
	if _, err := scanMP4(read, 7); err == nil {
		t.Fatal("truncated movie accepted")
	}
	noMoov := box("ftyp", []byte("isom"))
	if _, err := scanMP4(func(off, n int64) ([]byte, error) { return noMoov[off:min(off+n, int64(len(noMoov)))], nil },
		int64(len(noMoov))); !errors.Is(err, errNoMoov) {
		t.Fatalf("no moov: %v", err)
	}
}

func TestImageBombAndDerivatives(t *testing.T) {
	if _, err := imageConfig(mimePNG, pngBomb()); !errors.Is(err, errImageTooLarge) {
		t.Fatalf("bomb: %v", err)
	}
	d := newDecoder()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, testImage(2000, 1000), nil); err != nil {
		t.Fatal(err)
	}
	img, err := d.decode(t.Context(), mimeJPEG, buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	out, err := derive(img, 6, appv1.MediaSizeType_MEDIA_SIZE_TYPE_X)
	if err != nil {
		t.Fatal(err)
	}
	if out.width != 1000 || out.height != 2000 || len(out.renditions) != 3 {
		t.Fatalf("derive = %dx%d, %d renditions", out.width, out.height, len(out.renditions))
	}
	x := out.renditions[2]
	if x.typ != appv1.MediaSizeType_MEDIA_SIZE_TYPE_X || x.w != 640 || x.h != 1280 {
		t.Fatalf("X = %+v", x)
	}
	if len(out.inlineThumb) == 0 || len(out.inlineThumb) > inlineThumbMax {
		t.Fatalf("inline thumb of %d bytes", len(out.inlineThumb))
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(out.inlineThumb))
	if err != nil || cfg.Width != 20 || cfg.Height != 40 {
		t.Fatalf("thumb %v %v", cfg, err)
	}
	// A small image gets no renditions.
	small, _ := derive(image.NewRGBA(image.Rect(0, 0, 100, 50)), 1, appv1.MediaSizeType_MEDIA_SIZE_TYPE_X)
	if len(small.renditions) != 0 {
		t.Fatal("renditions for a small image")
	}
	if normalizeClientThumb([]byte("<svg/>")) != nil || normalizeClientThumb(out.inlineThumb) == nil {
		t.Fatal("client thumb check wrong")
	}
}

func TestTokens(t *testing.T) {
	s := newSigner(bytes.Repeat([]byte{1}, 32))
	now := time.Unix(1_800_000_000, 0)
	g := downloadGrant{tenant: "primary", fileID: 7, size: appv1.MediaSizeType_MEDIA_SIZE_TYPE_M, viewer: 42, chatID: 1 << 40,
		seq: 9, expires: now.Add(time.Hour)}
	tok := s.download(g)
	got, err := s.openDownload(tok, now)
	if err != nil || got != g {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	if _, err := s.openDownload(tok, now.Add(2*time.Hour)); !errors.Is(err, errExpired) {
		t.Fatalf("expired: %v", err)
	}
	raw := []byte(tok)
	raw[10] ^= 1
	if _, err := s.openDownload(string(raw), now); !errors.Is(err, errBadToken) {
		t.Fatalf("tampered: %v", err)
	}
	if _, err := newSigner(bytes.Repeat([]byte{2}, 32)).openDownload(tok, now); !errors.Is(err, errBadToken) {
		t.Fatal("token valid under another key")
	}
	if _, err := s.openPart(tok, now); !errors.Is(err, errBadToken) {
		t.Fatal("download token accepted as part token")
	}
	// After a key rotation, tokens of the previous key verify while it is set.
	rotated := newSigner(bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{1}, 32))
	if got, err := rotated.openDownload(tok, now); err != nil || got != g {
		t.Fatalf("previous key: %+v %v", got, err)
	}
	if _, err := newSigner(bytes.Repeat([]byte{1}, 32)).openDownload(rotated.download(g), now); !errors.Is(err, errBadToken) {
		t.Fatal("a rotated signer signs with the previous key")
	}
	pt := s.part(partGrant{uploadID: "abc", part: 3, expires: now.Add(time.Hour)})
	if p, err := s.openPart(pt, now); err != nil || p.part != 3 || p.uploadID != "abc" {
		t.Fatalf("part: %+v %v", p, err)
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		h             string
		start, length int64
		partial, ok   bool
	}{
		{"", 0, 100, false, true},
		{"bytes=0-9", 0, 10, true, true},
		{"bytes=90-", 90, 10, true, true},
		{"bytes=-5", 95, 5, true, true},
		{"bytes=95-500", 95, 5, true, true},
		{"bytes=100-", 0, 0, false, false},
		{"bytes=5-1", 0, 0, false, false},
		{"bytes=0-1,5-6", 0, 100, false, true},
	}
	for _, c := range cases {
		s, l, p, ok := parseRange(c.h, 100)
		if s != c.start || l != c.length || p != c.partial || ok != c.ok {
			t.Errorf("parseRange(%q) = %d %d %v %v", c.h, s, l, p, ok)
		}
	}
}

func TestWaveformAndHelpers(t *testing.T) {
	pcm := make([]byte, 2*1000)
	for i := range 1000 {
		v := int16(i * 30)
		pcm[2*i], pcm[2*i+1] = byte(v), byte(v>>8)
	}
	w := waveform(pcm, 100)
	if len(w) != 100 || w[99] != 255 || w[0] > w[50] {
		t.Fatalf("waveform = %v", w)
	}
	if parseDuration("  Duration: 00:01:02.50, start") != 62500 {
		t.Fatal("parseDuration")
	}
	if cleanFileName("../../etc/pass\u202Ewd\x00.txt") != "passwd.txt" || cleanFileName("C:\\x\\a.pdf") != "a.pdf" {
		t.Fatalf("cleanFileName = %q", cleanFileName("../../etc/pass\u202Ewd\x00.txt"))
	}
	if partSizeFor(100) != 8<<20 || partSizeFor(100<<30) != 11<<20 {
		t.Fatalf("partSizeFor = %d", partSizeFor(100<<30))
	}
	if partLength(20<<20, 8<<20, 3) != 4<<20 || partCount(20<<20, 8<<20) != 3 {
		t.Fatal("part math")
	}
}
