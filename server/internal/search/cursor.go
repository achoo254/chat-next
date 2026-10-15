package search

import (
	"encoding/base64"
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"
)

// key orders hits: newest first, then by chat and seq (both descending), so
// every hit has a unique place.
type key struct {
	date        time.Time
	chatID, seq int64
}

// before reports whether k comes after o in the result order (is older).
func (k key) before(o key) bool {
	if !k.date.Equal(o.date) {
		return k.date.Before(o.date)
	}
	if k.chatID != o.chatID {
		return k.chatID < o.chatID
	}
	return k.seq < o.seq
}

// Phases of a relevance-ranked search: first the exact-accent hits of the
// rank window, then everything else.
const (
	phaseExact = 0
	phaseRest  = 1
)

// cursor is the position after the last hit returned.
type cursor struct {
	phase int
	// after is the last hit returned in this phase; nil at its start.
	after *key
	// bound is the oldest match of the rank window, set once the window is
	// known (relevance order with an accented query).
	bound *key
	// request identifies the search the cursor belongs to.
	request uint64
}

const cursorVersion = "1"

func (c cursor) encode() string {
	parts := []string{cursorVersion, strconv.Itoa(c.phase), strconv.FormatUint(c.request, 36)}
	for _, k := range []*key{c.after, c.bound} {
		if k == nil {
			parts = append(parts, "", "", "")
			continue
		}
		parts = append(parts, strconv.FormatInt(k.date.UnixMicro(), 36), strconv.FormatInt(k.chatID, 36), strconv.FormatInt(k.seq, 36))
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(parts, ".")))
}

func decodeCursor(s string, request uint64) (cursor, error) {
	if s == "" {
		return cursor{request: request}, nil
	}
	if len(s) > 256 {
		return cursor{}, invalid("invalid cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return cursor{}, invalid("invalid cursor")
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 9 || parts[0] != cursorVersion {
		return cursor{}, invalid("invalid cursor")
	}
	c := cursor{}
	if c.phase, err = strconv.Atoi(parts[1]); err != nil || (c.phase != phaseExact && c.phase != phaseRest) {
		return cursor{}, invalid("invalid cursor")
	}
	if c.request, err = strconv.ParseUint(parts[2], 36, 64); err != nil || c.request != request {
		return cursor{}, invalid("the cursor belongs to another search")
	}
	if c.after, err = decodeKey(parts[3:6]); err != nil {
		return cursor{}, err
	}
	if c.bound, err = decodeKey(parts[6:9]); err != nil {
		return cursor{}, err
	}
	return c, nil
}

func decodeKey(parts []string) (*key, error) {
	if parts[0] == "" && parts[1] == "" && parts[2] == "" {
		return nil, nil
	}
	var v [3]int64
	for i, p := range parts {
		n, err := strconv.ParseInt(p, 36, 64)
		if err != nil {
			return nil, invalid("invalid cursor")
		}
		v[i] = n
	}
	if v[1] <= 0 || v[2] <= 0 {
		return nil, invalid("invalid cursor")
	}
	return &key{date: time.UnixMicro(v[0]).UTC(), chatID: v[1], seq: v[2]}, nil
}

// requestID identifies a search across its pages: a cursor is only valid
// for the request that issued it.
func requestID(req Request) uint64 {
	h := fnv.New64a()
	f := req.Filter
	_, _ = fmt.Fprintf(h, "%s|%d|%d|%d|%d|%s|%d|%d|%t|%d|%d", req.TenantID, req.UserID, req.ChatID, req.TopicID, req.Order,
		strings.TrimSpace(req.Query), f.FromID, f.MediaKind, f.HasLink, f.Since.Unix(), f.Until.Unix())
	return h.Sum64()
}
