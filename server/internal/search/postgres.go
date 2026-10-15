package search

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Querier runs read queries: a pool, a connection or a transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Postgres searches the messages table of the chat database. Visibility is
// enforced by the query itself (see the package comment).
type Postgres struct {
	db Querier
	// window is RankWindow; tests shrink it.
	window int
}

// NewPostgres returns the Searcher on db.
func NewPostgres(db Querier) *Postgres {
	return &Postgres{db: db, window: RankWindow}
}

var _ Searcher = (*Postgres)(nil)

// row is a matching message.
type row struct {
	key
	text string
}

// Search returns one page of the messages req.UserID can see that match.
func (p *Postgres) Search(ctx context.Context, req Request) (Page, error) {
	if req.TenantID == "" || req.UserID <= 0 || req.ChatID < 0 || req.TopicID < 0 || (req.TopicID != 0 && req.ChatID == 0) {
		return Page{}, invalid("missing searcher, or a topic without its chat")
	}
	limit := req.Limit
	if limit <= 0 {
		limit = PageDefault
	}
	limit = min(limit, PageMax)
	f := req.Filter
	if f.FromID < 0 || f.MediaKind < 0 || (!f.Since.IsZero() && !f.Until.IsZero() && f.Until.Before(f.Since)) {
		return Page{}, invalid("invalid filter")
	}
	q, err := parseQuery(req.Query)
	if err != nil {
		return Page{}, err
	}
	if len(q.tokens) == 0 && !f.any() {
		return Page{}, nil
	}
	c, err := decodeCursor(req.Cursor, requestID(req))
	if err != nil {
		return Page{}, err
	}
	s := scan{db: p.db, req: req, q: q, window: p.window}
	if req.Order == OrderNewest || !q.accented {
		return s.newest(ctx, c, limit)
	}
	return s.relevance(ctx, c, limit)
}

// scan runs the queries of one Search call.
type scan struct {
	db     Querier
	req    Request
	q      query
	window int
}

func (s scan) newest(ctx context.Context, c cursor, limit int) (Page, error) {
	rows, err := s.fetch(ctx, c.after, nil, limit+1, false)
	if err != nil {
		return Page{}, err
	}
	page := Page{Hits: hitsOf(rows[:min(len(rows), limit)])}
	if len(rows) > limit {
		last := rows[limit-1].key
		page.NextCursor = cursor{phase: phaseRest, after: &last, request: c.request}.encode()
	}
	return page, nil
}

// ranked is a hit and the phase that produced it.
type ranked struct {
	row
	phase int
}

// relevance pages through the exact-accent hits of the rank window (the
// newest RankWindow matches), then through every other match, both newest
// first.
func (s scan) relevance(ctx context.Context, c cursor, limit int) (Page, error) {
	if c.bound == nil && (c.phase == phaseRest || c.after != nil) {
		return Page{}, invalid("invalid cursor")
	}
	var out []ranked
	// prefetched holds the newest matches when this page fetched the window
	// from the top, so the rest phase need not read them again.
	var prefetched []row
	if c.phase == phaseExact {
		window, err := s.fetch(ctx, c.after, c.bound, s.window, true)
		if err != nil {
			return Page{}, err
		}
		if c.bound == nil {
			if len(window) == 0 {
				return Page{}, nil
			}
			bound := window[len(window)-1].key
			c.bound = &bound
			prefetched = window
		}
		var exact []row
		for _, r := range window {
			if s.q.exact(r.text) {
				exact = append(exact, r)
			}
		}
		if len(exact) > limit {
			last := exact[limit-1].key
			next := cursor{phase: phaseExact, after: &last, bound: c.bound, request: c.request}
			return Page{Hits: hitsOf(exact[:limit]), NextCursor: next.encode()}, nil
		}
		for _, r := range exact {
			out = append(out, ranked{row: r, phase: phaseExact})
		}
		c = cursor{phase: phaseRest, bound: c.bound, request: c.request}
	}

	// The rest phase skips what the exact phase returned: exact-accent
	// matches inside the window.
	ranksFirst := func(r row) bool { return !r.before(*c.bound) && s.q.exact(r.text) }
	need := limit + 1 - len(out)
	take := func(rows []row) {
		for _, r := range rows {
			if need == 0 {
				return
			}
			if !ranksFirst(r) {
				out = append(out, ranked{row: r, phase: phaseRest})
				need--
			}
		}
	}
	after := c.after
	exhausted := false
	if prefetched != nil {
		take(prefetched)
		exhausted = len(prefetched) < s.window
		after = &prefetched[len(prefetched)-1].key
	}
	for need > 0 && !exhausted {
		batch := need + 16
		rows, err := s.fetch(ctx, after, nil, batch, true)
		if err != nil {
			return Page{}, err
		}
		take(rows)
		exhausted = len(rows) < batch
		if len(rows) > 0 {
			after = &rows[len(rows)-1].key
		}
	}

	page := Page{}
	for _, r := range out[:min(len(out), limit)] {
		page.Hits = append(page.Hits, Hit{ChatID: r.chatID, Seq: r.seq})
	}
	if len(out) > limit {
		next := cursor{phase: phaseRest, bound: c.bound, request: c.request}
		if last := out[limit-1]; last.phase == phaseRest {
			next.after = &last.key
		}
		page.NextCursor = next.encode()
	}
	return page, nil
}

func hitsOf(rows []row) []Hit {
	hits := make([]Hit, len(rows))
	for i, r := range rows {
		hits[i] = Hit{ChatID: r.chatID, Seq: r.seq}
	}
	return hits
}

// statement collects the conditions and arguments of a query.
type statement struct {
	where []string
	args  []any
}

func (st *statement) arg(v any) string {
	st.args = append(st.args, v)
	return "$" + strconv.Itoa(len(st.args))
}

func (st *statement) and(cond string) {
	st.where = append(st.where, cond)
}

// tsQuery is the tsquery of the tokens: every token a lexeme, the last one
// (and any cut to LexemeMaxBytes) a prefix, so results follow typing. The
// input form of tsquery (a cast, not to_tsquery) takes quoted lexemes as
// they are, matching the lexemes stored by TSVector.
func tsQuery(tokens []string) string {
	quote := strings.NewReplacer(`\`, `\\`, `'`, `''`)
	parts := make([]string, len(tokens))
	for i, t := range tokens {
		lexeme, cut := capLexeme(t)
		parts[i] = "'" + quote.Replace(lexeme) + "'"
		if cut || i == len(tokens)-1 {
			parts[i] += ":*"
		}
	}
	return strings.Join(parts, " & ")
}

// likeEscaper escapes the LIKE wildcards and its escape character (the
// default, a backslash) of a token.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// match is the condition on the search columns of m that the query's tokens
// impose, its values added to st.
//   - No token (filters alone): any message with content, not service
//     messages. search_tsv tells, since the previous binary writes it too.
//   - Substring: search_text contains every token. A token of at least
//     SubstringMinRunes is a LIKE '%token%' the trigram index answers; a
//     shorter one is a strpos the index ignores (a pattern without a whole
//     trigram would scan all of it), checked on the rows the long ones
//     found.
//   - Word starts: the tsquery of the tokens on search_tsv.
func (q query) match(st *statement) string {
	switch {
	case len(q.tokens) == 0:
		return "(length(m.search_tsv) > 0 OR m.media_kind <> 0)"
	case q.substring:
		conds := make([]string, len(q.tokens))
		for i, t := range q.tokens {
			if utf8.RuneCountInString(t) >= SubstringMinRunes {
				conds[i] = "m.search_text LIKE " + st.arg("%"+likeEscaper.Replace(t)+"%")
			} else {
				conds[i] = "strpos(m.search_text, " + st.arg(t) + ") > 0"
			}
		}
		return strings.Join(conds, " AND ")
	default:
		return "m.search_tsv @@ " + st.arg(tsQuery(q.tokens)) + "::tsquery"
	}
}

// fetch returns up to limit matches older than after (nil: from the newest)
// and not older than bound (nil: no bound), newest first. withText loads the
// text for the exact-accent ranking.
func (s scan) fetch(ctx context.Context, after, bound *key, limit int, withText bool) ([]row, error) {
	st := &statement{}
	user := st.arg(s.req.UserID)
	tenant := st.arg(s.req.TenantID)
	// Visibility: a current member of a live, non-secret chat of the tenant,
	// within their history, not hidden for them, not deleted for everyone.
	// Hidden forum topics stay searchable.
	st.and("m.deleted_at IS NULL")
	st.and("m.seq >= cm.visible_from_seq")
	st.and(`NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = ` + user + ` AND h.chat_id = m.chat_id AND h.seq = m.seq)`)
	st.and(s.q.match(st))
	if s.req.ChatID != 0 {
		st.and("m.chat_id = " + st.arg(s.req.ChatID))
	}
	if s.req.TopicID != 0 {
		st.and("m.topic_id = " + st.arg(s.req.TopicID))
	}
	f := s.req.Filter
	if f.FromID != 0 {
		st.and("m.from_id = " + st.arg(f.FromID))
	}
	if f.MediaKind != 0 {
		st.and("m.media_kind = " + st.arg(f.MediaKind))
	}
	if f.HasLink {
		st.and("m.has_link")
	}
	if !f.Since.IsZero() {
		st.and("m.date >= " + st.arg(f.Since))
	}
	if !f.Until.IsZero() {
		st.and("m.date <= " + st.arg(f.Until))
	}
	if after != nil {
		st.and(fmt.Sprintf("(m.date, m.chat_id, m.seq) < (%s, %s, %s)", st.arg(after.date), st.arg(after.chatID), st.arg(after.seq)))
	}
	if bound != nil {
		st.and(fmt.Sprintf("(m.date, m.chat_id, m.seq) >= (%s, %s, %s)", st.arg(bound.date), st.arg(bound.chatID), st.arg(bound.seq)))
	}
	text := "''"
	if withText {
		text = "m.text"
	}
	sql := `SELECT m.chat_id, m.seq, m.date, ` + text + ` FROM messages m
		JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ` + user + ` AND cm.left_at IS NULL
		JOIN chats c ON c.id = m.chat_id AND c.tenant_id = ` + tenant + ` AND c.deleted_at IS NULL AND c.type <> 'secret'
		WHERE ` + strings.Join(st.where, " AND ") + `
		ORDER BY m.date DESC, m.chat_id DESC, m.seq DESC LIMIT ` + st.arg(limit)
	rows, err := s.db.Query(ctx, sql, st.args...)
	if err != nil {
		return nil, fmt.Errorf("search: query: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.chatID, &x.seq, &x.date, &x.text)
		return x, err
	})
	if err != nil {
		return nil, fmt.Errorf("search: query: %w", err)
	}
	return out, nil
}

// IsInvalid reports whether err rejects the request itself.
func IsInvalid(err error) bool {
	return errors.Is(err, ErrInvalid)
}
