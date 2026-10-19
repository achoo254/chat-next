package media

import (
	"encoding/binary"
	"errors"
)

// WebM and Matroska files are EBML: each element is an ID, a size and a
// body. Metadata that can name a person, a device or a place (title,
// writing and muxing app, date, track names, tags, attachments, chapters)
// is overwritten in place with a Void element of the same length whose
// body is zeroed, so the file keeps its size and every offset in it (seek
// head, cues) stays valid. Recorders write a Segment and Clusters of
// unknown size; elements after the clusters are found through the seek
// head instead of walking the clusters.

// EBML element IDs (with their marker bits, as written).
const (
	ebmlHeaderID  = 0x1A45DFA3
	ebmlSegment   = 0x18538067
	ebmlSeekHead  = 0x114D9B74
	ebmlSeek      = 0x4DBB
	ebmlSeekID    = 0x53AB
	ebmlSeekPos   = 0x53AC
	ebmlInfo      = 0x1549A966
	ebmlTracks    = 0x1654AE6B
	ebmlTrack     = 0xAE
	ebmlCluster   = 0x1F43B675
	ebmlTags      = 0x1254C367
	ebmlAttach    = 0x1941A469
	ebmlChapters  = 0x1043A770
	ebmlTitle     = 0x7BA9
	ebmlMuxingApp = 0x4D80
	ebmlWriteApp  = 0x5741
	ebmlDateUTC   = 0x4461
	ebmlTrackName = 0x536E
	ebmlVoid      = 0xEC
)

const (
	// webmMaxElements bounds the top-level elements walked in a segment.
	webmMaxElements = 4096
	// webmMaxMeta bounds an Info, Tracks or SeekHead body read into memory.
	webmMaxMeta = 4 << 20
)

var errEBML = errors.New("media: malformed EBML")

// ebmlElement is an element header found at offset.
type ebmlElement struct {
	id         uint32
	offset     int64
	headerSize int64
	size       int64 // body size; -1 when unknown
}

func (e ebmlElement) end() int64 { return e.offset + e.headerSize + e.size }

// readEBMLHeader parses the element header at the start of b, found at
// offset in the object.
func readEBMLHeader(b []byte, offset int64) (ebmlElement, error) {
	if len(b) == 0 {
		return ebmlElement{}, errEBML
	}
	idLen := vintLength(b[0])
	if idLen == 0 || idLen > 4 || len(b) < idLen {
		return ebmlElement{}, errEBML
	}
	var id uint32
	for _, c := range b[:idLen] {
		id = id<<8 | uint32(c)
	}
	rest := b[idLen:]
	if len(rest) == 0 {
		return ebmlElement{}, errEBML
	}
	sizeLen := vintLength(rest[0])
	if sizeLen == 0 || len(rest) < sizeLen {
		return ebmlElement{}, errEBML
	}
	size := int64(rest[0] & (0xFF >> sizeLen))
	unknown := size == int64(0xFF>>sizeLen)
	for _, c := range rest[1:sizeLen] {
		size = size<<8 | int64(c)
		unknown = unknown && c == 0xFF
	}
	e := ebmlElement{id: id, offset: offset, headerSize: int64(idLen + sizeLen), size: size}
	if unknown {
		e.size = -1
	}
	return e, nil
}

// vintLength is the length of the EBML variable-size integer starting with
// first (0 when it is not one).
func vintLength(first byte) int {
	for n := 1; n <= 8; n++ {
		if first&(0x80>>(n-1)) != 0 {
			return n
		}
	}
	return 0
}

// voidPatches overwrite the element (whole length) with a Void element
// whose body is zeroed.
func voidPatches(offset, length int64) []patch {
	for n := int64(1); n <= 8; n++ {
		body := length - 1 - n
		if body < 0 || body > 1<<(7*n)-2 {
			continue
		}
		head := make([]byte, 1+n)
		head[0] = ebmlVoid
		v := uint64(body) | 1<<(7*n)
		for i := n; i >= 1; i-- {
			head[i] = byte(v)
			v >>= 8
		}
		return []patch{{offset: offset, data: head, zero: body}}
	}
	return nil // length 1 cannot occur: an element has an ID and a size
}

// scanWebM returns the patches that remove the metadata of a WebM or
// Matroska object of size bytes. Past the parts it understands it stops
// rather than fails: what it found is still removed.
func scanWebM(read readAtFunc, size int64) ([]patch, error) {
	header := func(offset int64) (ebmlElement, error) {
		b, err := read(offset, 16)
		if err != nil {
			return ebmlElement{}, err
		}
		return readEBMLHeader(b, offset)
	}
	head, err := header(0)
	if err != nil || head.id != ebmlHeaderID || head.size < 0 {
		return nil, errEBML
	}
	seg, err := header(head.end())
	if err != nil || seg.id != ebmlSegment {
		return nil, errEBML
	}
	start := seg.offset + seg.headerSize
	end := size
	if seg.size >= 0 {
		end = min(size, seg.end())
	}
	var patches []patch
	voided := map[int64]bool{}
	var seeks []int64
	visit := func(e ebmlElement) error {
		if voided[e.offset] {
			return nil
		}
		switch e.id {
		case ebmlTags, ebmlAttach, ebmlChapters:
			if e.size < 0 || e.end() > end {
				return errEBML
			}
			voided[e.offset] = true
			patches = append(patches, voidPatches(e.offset, e.end()-e.offset)...)
		case ebmlInfo, ebmlTracks, ebmlSeekHead:
			if e.size < 0 || e.size > webmMaxMeta || e.end() > end {
				return errEBML
			}
			voided[e.offset] = true
			body, err := read(e.offset+e.headerSize, e.size)
			if err != nil || int64(len(body)) != e.size {
				return errEBML
			}
			base := e.offset + e.headerSize
			switch e.id {
			case ebmlInfo:
				patches = append(patches, voidChildren(body, base, ebmlTitle, ebmlMuxingApp, ebmlWriteApp, ebmlDateUTC)...)
			case ebmlTracks:
				walkChildren(body, base, func(t ebmlElement, tb []byte) {
					if t.id == ebmlTrack {
						patches = append(patches, voidChildren(tb, t.offset+t.headerSize, ebmlTrackName)...)
					}
				})
			case ebmlSeekHead:
				seeks = append(seeks, seekPositions(body, start)...)
			}
		}
		return nil
	}
	offset := start
	for range webmMaxElements {
		if offset >= end {
			break
		}
		e, err := header(offset)
		if err != nil {
			break
		}
		if err := visit(e); err != nil {
			break
		}
		if e.size < 0 || e.end() > end {
			break // an unknown-size cluster: the rest is reached through the seek head
		}
		offset = e.end()
	}
	// Elements the seek head points at, among them a second seek head.
	for i := 0; i < len(seeks) && i < webmMaxElements; i++ {
		if seeks[i] < start || seeks[i] >= end {
			continue
		}
		e, err := header(seeks[i])
		if err != nil {
			continue
		}
		_ = visit(e)
	}
	return patches, nil
}

// walkChildren calls fn for each child element (with its body) of a body
// that starts at base in the object; it stops at a malformed child.
func walkChildren(body []byte, base int64, fn func(ebmlElement, []byte)) {
	for off := int64(0); off < int64(len(body)); {
		e, err := readEBMLHeader(body[off:min(off+16, int64(len(body)))], base+off)
		if err != nil || e.size < 0 || off+e.headerSize+e.size > int64(len(body)) {
			return
		}
		fn(e, body[off+e.headerSize:off+e.headerSize+e.size])
		off += e.headerSize + e.size
	}
}

// voidChildren returns patches voiding the children of body with one of ids.
func voidChildren(body []byte, base int64, ids ...uint32) []patch {
	var out []patch
	walkChildren(body, base, func(e ebmlElement, _ []byte) {
		for _, id := range ids {
			if e.id == id {
				out = append(out, voidPatches(e.offset, e.headerSize+e.size)...)
			}
		}
	})
	return out
}

// seekPositions reads the positions (object offsets) of the elements a
// seek head lists that metadata may hide in.
func seekPositions(body []byte, segmentData int64) []int64 {
	var out []int64
	walkChildren(body, 0, func(e ebmlElement, b []byte) {
		if e.id != ebmlSeek {
			return
		}
		var id uint32
		var pos int64 = -1
		walkChildren(b, 0, func(c ebmlElement, v []byte) {
			switch {
			case c.id == ebmlSeekID && len(v) <= 4:
				for _, x := range v {
					id = id<<8 | uint32(x)
				}
			case c.id == ebmlSeekPos && len(v) <= 8:
				var buf [8]byte
				copy(buf[8-len(v):], v)
				pos = int64(binary.BigEndian.Uint64(buf[:]) & (1<<62 - 1))
			}
		})
		switch id {
		case ebmlTags, ebmlAttach, ebmlChapters, ebmlSeekHead, ebmlInfo, ebmlTracks:
			if pos >= 0 {
				out = append(out, segmentData+pos)
			}
		}
	})
	return out
}
