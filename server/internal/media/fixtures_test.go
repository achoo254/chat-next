package media

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

// gpsMarker is text planted in metadata; it must never survive.
const gpsMarker = "GPS-21.0285N-105.8542E-marker"

// testImage is a w x h gradient.
func testImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x * 255 / max(w, 1)), uint8(y * 255 / max(h, 1)), 128, 255})
		}
	}
	return img
}

// exifBlock is an APP1 EXIF segment with Orientation and an
// ImageDescription holding gpsMarker.
func exifBlock(orientation int) []byte {
	desc := []byte(gpsMarker + "\x00")
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8}
	tiff = binary.BigEndian.AppendUint16(tiff, 2)
	// Orientation SHORT.
	tiff = append(tiff, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(orientation), 0, 0)
	// ImageDescription ASCII at offset 8+2+24+4 = 38.
	tiff = append(tiff, 0x01, 0x0E, 0, 2)
	tiff = binary.BigEndian.AppendUint32(tiff, uint32(len(desc)))
	tiff = binary.BigEndian.AppendUint32(tiff, 38)
	tiff = append(tiff, 0, 0, 0, 0)
	tiff = append(tiff, desc...)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	return append(seg, payload...)
}

// jpegWithExif encodes a w x h JPEG carrying EXIF (orientation, secret),
// an XMP block, a comment, and an appended second image after EOI.
func jpegWithExif(t *testing.T, w, h, orientation int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, testImage(w, h), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	xmp := append([]byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>"), gpsMarker...)
	xmpSeg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(xmpSeg[2:], uint16(len(xmp)+2))
	xmpSeg = append(xmpSeg, xmp...)
	com := append([]byte{0xFF, 0xFE, 0, byte(len(gpsMarker) + 2)}, gpsMarker...)
	out := append([]byte{}, b[:2]...)
	out = append(out, exifBlock(orientation)...)
	out = append(out, xmpSeg...)
	out = append(out, com...)
	out = append(out, b[2:]...)
	return append(out, []byte("\xFF\xD8\xFF\xE1trailing "+gpsMarker)...)
}

func pngChunk(typ string, data []byte) []byte {
	c := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	c = append(c, typ...)
	c = append(c, data...)
	return binary.BigEndian.AppendUint32(c, crc32.ChecksumIEEE(append([]byte(typ), data...)))
}

// pngWithText is a PNG with a tEXt chunk holding gpsMarker.
func pngWithText(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, testImage(w, h)); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	// After the signature and IHDR (8 + 25 bytes).
	out := append([]byte{}, b[:33]...)
	out = append(out, pngChunk("tEXt", append([]byte("Comment\x00"), gpsMarker...))...)
	return append(out, b[33:]...)
}

// pngBomb declares a huge canvas with almost no data.
func pngBomb() []byte {
	ihdr := binary.BigEndian.AppendUint32(nil, 30000)
	ihdr = binary.BigEndian.AppendUint32(ihdr, 30000)
	ihdr = append(ihdr, 8, 6, 0, 0, 0)
	out := []byte("\x89PNG\r\n\x1a\n")
	out = append(out, pngChunk("IHDR", ihdr)...)
	out = append(out, pngChunk("IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})...)
	return append(out, pngChunk("IEND", nil)...)
}

func box(typ string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	b := binary.BigEndian.AppendUint32(nil, uint32(8+len(body)))
	return append(append(b, typ...), body...)
}

// testMP4 is a minimal movie: ftyp, moov (mvhd 12.5 s, one rotated video
// track 1920x1080, udta with a location, meta), then mdat of mdatSize.
func testMP4(mdatSize int) []byte {
	mvhd := make([]byte, 100)
	binary.BigEndian.PutUint32(mvhd[12:], 1000)  // timescale
	binary.BigEndian.PutUint32(mvhd[16:], 12500) // duration
	tkhd := make([]byte, 84)
	// matrix for 90 degrees: a=0, b=1, c=-1, d=0
	binary.BigEndian.PutUint32(tkhd[44:], 0x00010000)
	binary.BigEndian.PutUint32(tkhd[52:], 0xFFFF0000)
	binary.BigEndian.PutUint32(tkhd[76:], 1920<<16)
	binary.BigEndian.PutUint32(tkhd[80:], 1080<<16)
	hdlr := make([]byte, 24)
	copy(hdlr[8:], "vide")
	trak := box("trak", box("tkhd", tkhd), box("mdia", box("hdlr", hdlr)), box("udta", []byte(gpsMarker)))
	moov := box("moov", box("mvhd", mvhd), trak, box("udta", box("\xa9xyz", []byte(gpsMarker))),
		box("meta", []byte("location "+gpsMarker)))
	ftyp := box("ftyp", []byte("isom\x00\x00\x02\x00isomiso2mp41"))
	return append(append(ftyp, moov...), box("mdat", make([]byte, mdatSize))...)
}
