package media

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// errMalformed reports an image whose structure cannot be parsed; it is
// refused rather than served with metadata left in.
var errMalformed = errors.New("media: malformed image")

// stripImage removes metadata (EXIF with GPS, XMP, IPTC, comments, text
// chunks, data after the end of the image) from a raster image without
// re-encoding it. JPEG orientation survives as a minimal EXIF block holding
// only the Orientation tag, so browsers still display the photo upright.
// It returns the stripped bytes and the EXIF orientation (1 when none).
func stripImage(mime string, data []byte) ([]byte, int, error) {
	switch mime {
	case mimeJPEG:
		return stripJPEG(data)
	case mimePNG:
		out, err := stripPNG(data)
		return out, 1, err
	case mimeWebP:
		out, err := stripWebP(data)
		return out, 1, err
	case mimeGIF:
		out, err := stripGIF(data)
		return out, 1, err
	}
	return nil, 0, errMalformed
}

// ---------------------------------------------------------------- JPEG

// JPEG markers.
const (
	jpegSOI  = 0xD8
	jpegEOI  = 0xD9
	jpegSOS  = 0xDA
	jpegAPP0 = 0xE0
	jpegAPP1 = 0xE1
	jpegAPP2 = 0xE2
	jpegAPPE = 0xEE
	jpegAPPF = 0xEF
	jpegCOM  = 0xFE
)

// stripJPEG keeps the image segments (tables, frames, scans), JFIF (APP0),
// the ICC profile (APP2 "ICC_PROFILE") and Adobe's color transform
// (APP14 "Adobe"); it drops every other APPn (EXIF, XMP, IPTC, MPF, maker
// data), comments and anything after EOI (appended images such as depth
// maps carry their own EXIF).
func stripJPEG(data []byte) ([]byte, int, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != jpegSOI {
		return nil, 0, errMalformed
	}
	out := bytes.NewBuffer(make([]byte, 0, len(data)))
	out.Write(data[:2])
	orientation := 1
	wroteOrientation := false
	writeOrientation := func() {
		if !wroteOrientation && orientation != 1 {
			out.Write(orientationSegment(orientation))
		}
		wroteOrientation = true
	}
	i := 2
	for {
		// Marker, possibly preceded by fill bytes.
		for i < len(data) && data[i] == 0xFF && i+1 < len(data) && data[i+1] == 0xFF {
			i++
		}
		if i+1 >= len(data) || data[i] != 0xFF {
			return nil, 0, errMalformed
		}
		marker := data[i+1]
		if marker == jpegEOI {
			writeOrientation()
			out.Write(data[i : i+2])
			return out.Bytes(), orientation, nil
		}
		if marker >= 0xD0 && marker <= 0xD7 || marker == 0x01 {
			out.Write(data[i : i+2]) // standalone marker
			i += 2
			continue
		}
		if i+4 > len(data) {
			return nil, 0, errMalformed
		}
		n := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		end := i + 2 + n
		if n < 2 || end > len(data) {
			return nil, 0, errMalformed
		}
		seg := data[i:end]
		payload := data[i+4 : end]
		keep := true
		switch {
		case marker == jpegAPP1:
			if bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
				if o := exifOrientation(payload[6:]); o >= 1 && o <= 8 {
					orientation = o
				}
			}
			keep = false
		case marker == jpegAPP0:
			keep = bytes.HasPrefix(payload, []byte("JFIF\x00"))
		case marker == jpegAPP2:
			keep = bytes.HasPrefix(payload, []byte("ICC_PROFILE\x00"))
		case marker == jpegAPPE:
			keep = bytes.HasPrefix(payload, []byte("Adobe"))
		case marker > jpegAPP2 && marker <= jpegAPPF, marker == jpegCOM:
			keep = false
		}
		if marker != jpegAPP0 && marker != jpegAPP1 && !wroteOrientation {
			// The orientation block goes right after SOI/JFIF, before the
			// first table or frame segment.
			writeOrientation()
		}
		if keep {
			out.Write(seg)
		}
		i = end
		if marker != jpegSOS {
			continue
		}
		// Entropy-coded data runs to the next marker that is neither a
		// stuffed 0xFF00 nor a restart marker.
		start := i
		for {
			j := bytes.IndexByte(data[i:], 0xFF)
			if j < 0 {
				return nil, 0, errMalformed
			}
			i += j
			if i+1 >= len(data) {
				return nil, 0, errMalformed
			}
			next := data[i+1]
			if next == 0x00 || (next >= 0xD0 && next <= 0xD7) || next == 0xFF {
				i++
				if next != 0xFF {
					i++
				}
				continue
			}
			break
		}
		out.Write(data[start:i])
	}
}

// exifOrientation reads tag 0x0112 of IFD0 from a TIFF block; 0 when absent.
func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	off := int(order.Uint32(tiff[4:8]))
	if off < 8 || off+2 > len(tiff) {
		return 0
	}
	n := int(order.Uint16(tiff[off : off+2]))
	for k := range n {
		e := off + 2 + k*12
		if e+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[e:e+2]) == 0x0112 && order.Uint16(tiff[e+2:e+4]) == 3 {
			return int(order.Uint16(tiff[e+8 : e+10]))
		}
	}
	return 0
}

// orientationSegment is an APP1 EXIF block with only IFD0 Orientation.
func orientationSegment(orientation int) []byte {
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, // header, IFD0 at 8
		0, 1, // one entry
		0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(orientation), 0, 0, // Orientation SHORT
		0, 0, 0, 0, // no next IFD
	}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, jpegAPP1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	return append(seg, payload...)
}

// ----------------------------------------------------------------- PNG

// pngKeep are the chunks kept besides the critical ones: color, gamma,
// transparency, physical size and animation (APNG).
var pngKeep = map[string]bool{
	"tRNS": true, "cHRM": true, "gAMA": true, "iCCP": true, "sBIT": true, "sRGB": true, "bKGD": true,
	"pHYs": true, "acTL": true, "fcTL": true, "fdAT": true, "cICP": true,
}

func stripPNG(data []byte) ([]byte, error) {
	const sig = 8
	if len(data) < sig || !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return nil, errMalformed
	}
	out := bytes.NewBuffer(make([]byte, 0, len(data)))
	out.Write(data[:sig])
	for i := sig; ; {
		if i+8 > len(data) {
			return nil, errMalformed
		}
		n := int(binary.BigEndian.Uint32(data[i : i+4]))
		typ := string(data[i+4 : i+8])
		end := i + 12 + n
		if n < 0 || end > len(data) || end < i {
			return nil, errMalformed
		}
		critical := typ[0] >= 'A' && typ[0] <= 'Z'
		if critical || pngKeep[typ] {
			out.Write(data[i:end])
		}
		if typ == "IEND" {
			return out.Bytes(), nil
		}
		i = end
	}
}

// ---------------------------------------------------------------- WebP

// webpKeep are the chunks kept; EXIF, XMP and unknown chunks go.
var webpKeep = map[string]bool{"VP8 ": true, "VP8L": true, "VP8X": true, "ALPH": true, "ANIM": true, "ANMF": true, "ICCP": true}

func stripWebP(data []byte) ([]byte, error) {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil, errMalformed
	}
	riffEnd := 8 + int(binary.LittleEndian.Uint32(data[4:8]))
	if riffEnd > len(data) || riffEnd < 12 {
		return nil, errMalformed
	}
	out := bytes.NewBuffer(make([]byte, 0, len(data)))
	out.Write(data[:12])
	vp8x := -1
	for i := 12; i < riffEnd; {
		if i+8 > riffEnd {
			return nil, errMalformed
		}
		typ := string(data[i : i+4])
		n := int(binary.LittleEndian.Uint32(data[i+4 : i+8]))
		end := i + 8 + n + n%2
		if n < 0 || end > riffEnd || end < i {
			return nil, errMalformed
		}
		if webpKeep[typ] {
			if typ == "VP8X" {
				vp8x = out.Len()
			}
			out.Write(data[i:end])
		}
		i = end
	}
	b := out.Bytes()
	if vp8x >= 0 && vp8x+9 <= len(b) {
		b[vp8x+8] &^= 0x08 | 0x04 // EXIF and XMP flags
	}
	binary.LittleEndian.PutUint32(b[4:8], uint32(len(b)-8))
	return b, nil
}

// ----------------------------------------------------------------- GIF

// stripGIF drops comment extensions and application extensions other than
// the looping ones (NETSCAPE2.0, ANIMEXTS1.0), and anything after the
// trailer.
func stripGIF(data []byte) ([]byte, error) {
	if len(data) < 13 {
		return nil, errMalformed
	}
	out := bytes.NewBuffer(make([]byte, 0, len(data)))
	i := 13
	if data[10]&0x80 != 0 {
		i += 3 << (int(data[10]&0x07) + 1)
	}
	if i > len(data) {
		return nil, errMalformed
	}
	out.Write(data[:i])
	// subBlocks returns the end of the sub-block chain starting at j.
	subBlocks := func(j int) (int, error) {
		for {
			if j >= len(data) {
				return 0, errMalformed
			}
			n := int(data[j])
			j++
			if n == 0 {
				return j, nil
			}
			j += n
		}
	}
	for {
		if i >= len(data) {
			return nil, errMalformed
		}
		switch data[i] {
		case 0x3B: // trailer
			out.WriteByte(0x3B)
			return out.Bytes(), nil
		case 0x21: // extension
			if i+2 > len(data) {
				return nil, errMalformed
			}
			label := data[i+1]
			end, err := subBlocks(i + 2)
			if err != nil {
				return nil, err
			}
			keep := label != 0xFE
			if label == 0xFF {
				id := data[i+2 : min(i+2+12, len(data))]
				keep = bytes.Contains(id, []byte("NETSCAPE2.0")) || bytes.Contains(id, []byte("ANIMEXTS1.0"))
			}
			if keep {
				out.Write(data[i:end])
			}
			i = end
		case 0x2C: // image descriptor
			j := i + 10
			if j > len(data) {
				return nil, errMalformed
			}
			if data[i+9]&0x80 != 0 {
				j += 3 << (int(data[i+9]&0x07) + 1)
			}
			j++ // LZW minimum code size
			end, err := subBlocks(j)
			if err != nil {
				return nil, err
			}
			out.Write(data[i:end])
			i = end
		default:
			return nil, errMalformed
		}
	}
}
