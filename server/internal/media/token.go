package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// Token versions (first byte), one per purpose.
const (
	tokenDownload = 1
	tokenPart     = 2
	macLen        = 16
)

var (
	// errBadToken reports a token that is malformed or not signed by us.
	errBadToken = errors.New("media: invalid token")
	// errExpired reports a well-signed token past its expiry.
	errExpired = errors.New("media: token expired")
)

// signer signs short-lived media tokens with a key derived from the
// session key, so no new secret is needed; rotating SESSION_KEY also
// invalidates every outstanding media URL.
type signer struct {
	key []byte
}

func newSigner(sessionKey []byte) signer {
	mac := hmac.New(sha256.New, sessionKey)
	mac.Write([]byte("chat media tokens v1"))
	return signer{key: mac.Sum(nil)}
}

func (s signer) seal(payload []byte) string {
	mac := hmac.New(sha256.New, s.key)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(append(payload, mac.Sum(nil)[:macLen]...))
}

func (s signer) open(token string, version byte) ([]byte, error) {
	if len(token) > 512 {
		return nil, errBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < macLen+1 || raw[0] != version {
		return nil, errBadToken
	}
	payload, sum := raw[:len(raw)-macLen], raw[len(raw)-macLen:]
	mac := hmac.New(sha256.New, s.key)
	mac.Write(payload)
	if !hmac.Equal(sum, mac.Sum(nil)[:macLen]) {
		return nil, errBadToken
	}
	return payload, nil
}

// downloadGrant is what a download token proves: viewer may read the
// rendition of file through the message (chat_id, seq) of tenant, until
// expires.
type downloadGrant struct {
	tenant  string
	fileID  int64
	size    appv1.MediaSizeType
	viewer  int64
	chatID  int64
	seq     int64
	expires time.Time
}

func (s signer) download(g downloadGrant) string {
	b := []byte{tokenDownload}
	b = binary.BigEndian.AppendUint32(b, uint32(g.expires.Unix()))
	b = binary.AppendUvarint(b, uint64(g.fileID))
	b = append(b, byte(g.size))
	b = binary.AppendUvarint(b, uint64(g.viewer))
	b = binary.AppendUvarint(b, uint64(g.chatID))
	b = binary.AppendUvarint(b, uint64(g.seq))
	b = append(b, byte(len(g.tenant)))
	b = append(b, g.tenant...)
	return s.seal(b)
}

// reader walks a token payload.
type reader struct {
	b   []byte
	bad bool
}

func (r *reader) uvarint() int64 {
	v, n := binary.Uvarint(r.b)
	if n <= 0 || v >= 1<<53 {
		r.bad = true
		return 0
	}
	r.b = r.b[n:]
	return int64(v)
}

func (r *reader) byte() byte {
	if len(r.b) < 1 {
		r.bad = true
		return 0
	}
	v := r.b[0]
	r.b = r.b[1:]
	return v
}

func (r *reader) uint32() uint32 {
	if len(r.b) < 4 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *reader) string() string {
	n := int(r.byte())
	if r.bad || len(r.b) < n {
		r.bad = true
		return ""
	}
	v := string(r.b[:n])
	r.b = r.b[n:]
	return v
}

func (s signer) openDownload(token string, now time.Time) (downloadGrant, error) {
	payload, err := s.open(token, tokenDownload)
	if err != nil {
		return downloadGrant{}, err
	}
	r := &reader{b: payload[1:]}
	g := downloadGrant{expires: time.Unix(int64(r.uint32()), 0)}
	g.fileID = r.uvarint()
	g.size = appv1.MediaSizeType(r.byte())
	g.viewer = r.uvarint()
	g.chatID = r.uvarint()
	g.seq = r.uvarint()
	g.tenant = r.string()
	if r.bad || len(r.b) != 0 {
		return downloadGrant{}, errBadToken
	}
	if !now.Before(g.expires) {
		return g, errExpired
	}
	return g, nil
}

// partGrant lets a browser PUT one part of an upload through the media
// host (proxy upload mode).
type partGrant struct {
	uploadID string
	part     int
	expires  time.Time
}

func (s signer) part(g partGrant) string {
	b := []byte{tokenPart}
	b = binary.BigEndian.AppendUint32(b, uint32(g.expires.Unix()))
	b = binary.AppendUvarint(b, uint64(g.part))
	b = append(b, byte(len(g.uploadID)))
	b = append(b, g.uploadID...)
	return s.seal(b)
}

func (s signer) openPart(token string, now time.Time) (partGrant, error) {
	payload, err := s.open(token, tokenPart)
	if err != nil {
		return partGrant{}, err
	}
	r := &reader{b: payload[1:]}
	g := partGrant{expires: time.Unix(int64(r.uint32()), 0)}
	g.part = int(r.uvarint())
	g.uploadID = r.string()
	if r.bad || len(r.b) != 0 || g.part < 1 {
		return partGrant{}, errBadToken
	}
	if !now.Before(g.expires) {
		return g, errExpired
	}
	return g, nil
}
