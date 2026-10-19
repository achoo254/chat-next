package media

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// ebml encodes an element with an 8-byte size, or an unknown size when
// unknown is set.
func ebml(id uint32, body []byte, unknown bool) []byte {
	var out []byte
	for shift := 24; shift >= 0; shift -= 8 {
		if b := byte(id >> shift); b != 0 || len(out) > 0 {
			out = append(out, b)
		}
	}
	size := make([]byte, 8)
	if unknown {
		binary.BigEndian.PutUint64(size, 0x01FFFFFFFFFFFFFF)
	} else {
		binary.BigEndian.PutUint64(size, 0x0100000000000000|uint64(len(body)))
	}
	return append(append(out, size...), body...)
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// testWebM builds a recorder-like file: an unknown-size segment holding a
// seek head, info and tracks with personal metadata, an unknown-size
// cluster, and tags after it that only the seek head points to.
func testWebM() []byte {
	info := ebml(ebmlInfo, cat(
		ebml(0x2AD7B1, []byte{0x0F, 0x42, 0x40}, false), // TimecodeScale
		ebml(ebmlMuxingApp, []byte("Chrome"), false),
		ebml(ebmlWriteApp, []byte("Chrome"), false),
		ebml(ebmlTitle, []byte("Đường Trần Hưng Đạo "+gpsMarker), false),
		ebml(ebmlDateUTC, make([]byte, 8), false)), false)
	tracks := ebml(ebmlTracks, ebml(ebmlTrack, cat(
		ebml(0xD7, []byte{1}, false), // TrackNumber
		ebml(ebmlTrackName, []byte("iPhone của An"), false),
		ebml(0x86, []byte("V_VP8"), false)), false), false) // CodecID
	tags := ebml(ebmlTags, ebml(0x7373, []byte("location "+gpsMarker), false), false)
	cluster := ebml(ebmlCluster, cat(ebml(0xE7, []byte{0}, false), ebml(0xA3, make([]byte, 64), false)), true)
	// The seek head's size does not depend on the positions written in it.
	seekHead := func(tagsPos int64) []byte {
		pos := make([]byte, 8)
		binary.BigEndian.PutUint64(pos, uint64(tagsPos))
		return ebml(ebmlSeekHead, ebml(ebmlSeek, cat(ebml(ebmlSeekID, []byte{0x12, 0x54, 0xC3, 0x67}, false),
			ebml(ebmlSeekPos, pos, false)), false), false)
	}
	tagsPos := int64(len(seekHead(0)) + len(info) + len(tracks) + len(cluster))
	header := ebml(ebmlHeaderID, ebml(0x4282, []byte("webm"), false), false)
	segment := ebml(ebmlSegment, cat(seekHead(tagsPos), info, tracks, cluster, tags), true)
	return cat(header, segment)
}

func TestScanWebMRemovesMetadata(t *testing.T) {
	data := testWebM()
	read := func(b []byte) readAtFunc {
		return func(off, n int64) ([]byte, error) { return bytes.Clone(b[off:min(off+n, int64(len(b)))]), nil }
	}
	patches, err := scanWebM(read(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := bytes.Clone(data)
	applyPatches(out, 0, patches)
	for _, secret := range []string{gpsMarker, "Chrome", "iPhone", "location"} {
		if bytes.Contains(out, []byte(secret)) {
			t.Fatalf("%q left in the file", secret)
		}
	}
	if len(out) != len(data) || !bytes.Contains(out, []byte("V_VP8")) || !bytes.Contains(out, []byte("webm")) {
		t.Fatal("the file changed beyond its metadata")
	}
	// What is left is valid EBML with nothing more to remove.
	again, err := scanWebM(read(out), int64(len(out)))
	if err != nil || len(again) != 0 {
		t.Fatalf("rescan = %d patches, %v", len(again), err)
	}
	// Not EBML at all.
	if _, err := scanWebM(read([]byte("not a webm file")), 15); err == nil {
		t.Fatal("non-EBML accepted")
	}
}

func TestVoidPatchesFillTheElement(t *testing.T) {
	for _, length := range []int64{2, 3, 127, 128, 129, 16385, 1 << 20} {
		ps := voidPatches(0, length)
		if len(ps) != 1 || ps[0].end() != length {
			t.Fatalf("length %d: %+v", length, ps)
		}
		b := make([]byte, length)
		applyPatches(b, 0, ps)
		e, err := readEBMLHeader(b, 0)
		if err != nil || e.id != ebmlVoid || e.end() != length {
			t.Fatalf("length %d: void %+v, %v", length, e, err)
		}
	}
}
