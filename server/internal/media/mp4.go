package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// Limits of the MP4 scan.
const (
	mp4MaxTopBoxes = 256
	// mp4MaxMoov bounds the movie header read into memory; a 2 GB phone
	// video has a moov of a few MB.
	mp4MaxMoov  = 64 << 20
	mp4MaxDepth = 8
)

// errMoovTooLarge reports a movie header above mp4MaxMoov.
var errMoovTooLarge = errors.New("media: movie header is too large")

// errNoMoov reports an MP4/QuickTime file without a movie header.
var errNoMoov = errors.New("media: video has no movie header")

// xmpUUID is the uuid box type Adobe XMP is stored in.
var xmpUUID = []byte{0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC}

// patch overwrites bytes of an object at an offset.
type patch struct {
	offset int64
	data   []byte
}

// mp4Info is what the scan learned about a movie.
type mp4Info struct {
	// patches rename metadata boxes (udta, meta, XMP uuid) to "free", so
	// players skip them; sizes never change.
	patches    []patch
	durationMS int64
	// Display size of the first video track (rotation applied); 0 for
	// audio-only files.
	width, height int
}

// readAtFunc reads n bytes at offset (fewer only at the end of the object).
type readAtFunc func(offset, n int64) ([]byte, error)

type boxHeader struct {
	typ        string
	offset     int64 // of the header
	headerSize int64
	size       int64 // whole box
}

func readBoxHeader(b []byte, offset, limit int64) (boxHeader, error) {
	if len(b) < 8 {
		return boxHeader{}, errMalformed
	}
	h := boxHeader{typ: string(b[4:8]), offset: offset, headerSize: 8, size: int64(binary.BigEndian.Uint32(b[:4]))}
	switch h.size {
	case 1:
		if len(b) < 16 {
			return boxHeader{}, errMalformed
		}
		h.headerSize = 16
		h.size = int64(binary.BigEndian.Uint64(b[8:16]))
	case 0:
		h.size = limit - offset
	}
	if h.size < h.headerSize || offset+h.size > limit || h.size < 0 {
		return boxHeader{}, errMalformed
	}
	if h.typ == "uuid" && h.headerSize+16 <= int64(len(b)) {
		h.headerSize += 16
	}
	return h, nil
}

// scanMP4 walks the top-level boxes of an object of size bytes (reading
// only box headers and the moov box), and returns the patches that blank
// its metadata together with duration and dimensions.
func scanMP4(read readAtFunc, size int64) (*mp4Info, error) {
	info := &mp4Info{}
	var moov *boxHeader
	offset := int64(0)
	for range mp4MaxTopBoxes {
		if offset >= size {
			break
		}
		head, err := read(offset, 32)
		if err != nil {
			return nil, err
		}
		h, err := readBoxHeader(head, offset, size)
		if err != nil {
			return nil, err
		}
		switch h.typ {
		case "moov":
			if moov != nil {
				return nil, errMalformed
			}
			hh := h
			moov = &hh
		case "udta", "meta":
			info.patches = append(info.patches, renameFree(h))
		case "uuid":
			if len(head) >= 24 && bytes.Equal(head[8:24], xmpUUID) {
				info.patches = append(info.patches, renameFree(h))
			}
		}
		offset += h.size
	}
	if moov == nil {
		return nil, errNoMoov
	}
	if moov.size > mp4MaxMoov {
		return nil, fmt.Errorf("%w: %d bytes", errMoovTooLarge, moov.size)
	}
	body, err := read(moov.offset, moov.size)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) != moov.size {
		return nil, errMalformed
	}
	if err := walkMoov(body, moov.offset, moov.headerSize, 0, info, ""); err != nil {
		return nil, err
	}
	return info, nil
}

func renameFree(h boxHeader) patch {
	// "uuid" boxes keep their extended type after the header, which is
	// harmless inside a free box.
	return patch{offset: h.offset + 4, data: []byte("free")}
}

// trackState collects one trak's facts while walking it.
type trackState struct {
	handler       string
	width, height int
	rotated       bool
}

// walkMoov walks the container box b (its bytes start at base in the
// object) from offset start, collecting patches, duration and track facts.
func walkMoov(b []byte, base, start int64, depth int, info *mp4Info, parent string) error {
	if depth > mp4MaxDepth {
		return errMalformed
	}
	var track *trackState
	if parent == "trak" {
		track = &trackState{}
	}
	for off := start; off < int64(len(b)); {
		h, err := readBoxHeader(b[off:min(off+32, int64(len(b)))], off, int64(len(b)))
		if err != nil {
			return err
		}
		body := b[off+h.headerSize : off+h.size]
		switch h.typ {
		case "udta", "meta":
			info.patches = append(info.patches, patch{offset: base + off + 4, data: []byte("free")})
		case "uuid":
			if h.size >= 24 && bytes.Equal(b[off+8:off+24], xmpUUID) {
				info.patches = append(info.patches, patch{offset: base + off + 4, data: []byte("free")})
			}
		case "mvhd":
			info.durationMS = mvhdDuration(body)
		case "tkhd":
			if track != nil {
				track.width, track.height, track.rotated = tkhdSize(body)
			}
		case "trak", "mdia":
			if h.typ == "trak" {
				if err := walkMoov(b[off:off+h.size], base+off, h.headerSize, depth+1, info, "trak"); err != nil {
					return err
				}
				break
			}
			handler := mdiaHandler(body)
			if track != nil {
				track.handler = handler
			}
		}
		off += h.size
	}
	if track != nil && track.handler == "vide" && info.width == 0 && track.width > 0 && track.height > 0 {
		info.width, info.height = track.width, track.height
		if track.rotated {
			info.width, info.height = track.height, track.width
		}
	}
	return nil
}

// mvhdDuration reads duration/timescale of a movie header in milliseconds.
func mvhdDuration(b []byte) int64 {
	if len(b) < 4 {
		return 0
	}
	var timescale, duration uint64
	if b[0] == 1 {
		if len(b) < 32 {
			return 0
		}
		timescale = uint64(binary.BigEndian.Uint32(b[20:24]))
		duration = binary.BigEndian.Uint64(b[24:32])
	} else {
		if len(b) < 20 {
			return 0
		}
		timescale = uint64(binary.BigEndian.Uint32(b[12:16]))
		duration = uint64(binary.BigEndian.Uint32(b[16:20]))
	}
	if timescale == 0 || duration == ^uint64(0) || duration == 0xFFFFFFFF {
		return 0
	}
	return int64(duration * 1000 / timescale)
}

// tkhdSize reads the presentation size of a track header and whether its
// matrix rotates by 90 or 270 degrees.
func tkhdSize(b []byte) (w, h int, rotated bool) {
	if len(b) < 4 {
		return 0, 0, false
	}
	matrix := 40 // version 0: after flags, times, id, reserved, duration, reserved, layer, group, volume, reserved
	if b[0] == 1 {
		matrix = 52
	}
	if len(b) < matrix+36+8 {
		return 0, 0, false
	}
	a := int32(binary.BigEndian.Uint32(b[matrix : matrix+4]))
	d := int32(binary.BigEndian.Uint32(b[matrix+16 : matrix+20]))
	w = int(binary.BigEndian.Uint32(b[matrix+36:matrix+40]) >> 16)
	h = int(binary.BigEndian.Uint32(b[matrix+40:matrix+44]) >> 16)
	return w, h, a == 0 && d == 0
}

// mdiaHandler returns the handler type ("vide", "soun", ...) of a mdia box.
func mdiaHandler(b []byte) string {
	for off := 0; off+8 <= len(b); {
		size := int(binary.BigEndian.Uint32(b[off : off+4]))
		if size < 8 || off+size > len(b) {
			return ""
		}
		if string(b[off+4:off+8]) == "hdlr" && size >= 20 {
			return string(b[off+16 : off+20])
		}
		off += size
	}
	return ""
}
