// Package search finds messages for SearchService (release R4, phase 7).
//
// Searcher is the engine seam: Postgres implements it today over the
// messages table (a vifold search text column with a trigram index), and a
// dedicated engine (Meilisearch, OpenSearch) can replace it later without
// touching the RPCs. Every implementation must enforce the same visibility in
// its own query or in a re-check against Postgres: current membership of the
// searcher, the member's visible_from_seq, messages hidden for the searcher,
// messages deleted for everyone, the tenant, and never a secret chat.
//
// Matching follows ADR 0005: the query is folded with vifold, so unaccented
// input finds accented text. Every query token must start a word of the
// message (its text, caption or file name); the last token may be the
// beginning of a word, so results follow typing.
package search

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"app.local/server/internal/vifold"
	"golang.org/x/text/unicode/norm"
)

// Limits of a search request.
const (
	// QueryMaxRunes bounds the query text.
	QueryMaxRunes = 256
	// TokensMax bounds the tokens matched; more are refused.
	TokensMax = 8
	// PageDefault and PageMax bound a page of hits.
	PageDefault = 20
	PageMax     = 50
)

// Order is how hits are ranked.
type Order int

const (
	// OrderRelevance puts messages that contain the query with its exact
	// accents first (among the newest RankWindow matches), then the rest,
	// newest first. Global search uses it.
	OrderRelevance Order = iota
	// OrderNewest is newest first only, so a client can step through the
	// hits of one chat in order.
	OrderNewest
)

// RankWindow is how many of the newest matches are re-ranked by accents. A
// match older than that keeps its place by date, which bounds the work of
// a query that matches much of the history.
const RankWindow = 500

// Filter narrows the messages searched. Zero values do not filter.
type Filter struct {
	FromID int64
	// MediaKind is an app.v1.MediaKind value; 0 means any message.
	MediaKind int16
	// HasLink keeps only messages with a link.
	HasLink bool
	// Since and Until bound the message date, both inclusive; zero times are
	// unbounded.
	Since, Until time.Time
}

func (f Filter) any() bool {
	return f.FromID != 0 || f.MediaKind != 0 || f.HasLink || !f.Since.IsZero() || !f.Until.IsZero()
}

// Request is one page of a search.
type Request struct {
	TenantID string
	// UserID is the searcher; only messages they can see are returned.
	UserID int64
	// ChatID limits the search to one chat (0 = every chat of the user), and
	// TopicID to one forum topic of it (0 = every topic).
	ChatID, TopicID int64
	Query           string
	Filter          Filter
	Order           Order
	// Cursor is the opaque NextCursor of the previous page; "" for the first.
	Cursor string
	// Limit is the page size, PageDefault when 0, at most PageMax.
	Limit int
}

// Hit is one message found.
type Hit struct {
	ChatID, Seq int64
}

// Page is a page of hits. A page is full or the last one (NextCursor ""),
// and never repeats a hit of an earlier page of the same search.
type Page struct {
	Hits       []Hit
	NextCursor string
}

// Searcher finds the messages a user can see.
type Searcher interface {
	Search(ctx context.Context, req Request) (Page, error)
}

// ErrInvalid wraps every rejection of a request (bad query, cursor or
// filter); callers answer it as invalid_argument.
var ErrInvalid = errors.New("search: invalid request")

func invalid(reason string) error {
	return &invalidError{reason: reason}
}

type invalidError struct{ reason string }

func (e *invalidError) Error() string { return "search: " + e.reason }

func (e *invalidError) Unwrap() error { return ErrInvalid }

// query is a parsed request text.
type query struct {
	// tokens are the vifold tokens every hit must contain as word starts.
	tokens []string
	// words are the query's words in lower case with their accents, for the
	// exact-accent ranking; accented is set when any word has a mark.
	words    []string
	accented bool
}

func parseQuery(text string) (query, error) {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) > QueryMaxRunes {
		return query{}, invalid("the query is too long")
	}
	q := query{tokens: vifold.Tokens(text)}
	if len(q.tokens) > TokensMax {
		return query{}, invalid("the query has too many words")
	}
	for _, w := range strings.Fields(lowerNFC(text)) {
		w = strings.TrimFunc(w, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
		if w == "" {
			continue
		}
		q.words = append(q.words, w)
		if vifold.Fold(w) != w {
			q.accented = true
		}
	}
	return q, nil
}

// lowerNFC lower-cases text in composed form, keeping its accents.
func lowerNFC(text string) string {
	return strings.ToLower(norm.NFC.String(text))
}

// exact reports whether text holds every query word with its accents.
func (q query) exact(text string) bool {
	lowered := lowerNFC(text)
	for _, w := range q.words {
		if !strings.Contains(lowered, w) {
			return false
		}
	}
	return true
}
