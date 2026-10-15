package search

// SetRankWindow shrinks the rank window of p so tests reach its edge with
// few messages.
func SetRankWindow(p *Postgres, n int) {
	p.window = n
}

// TSQueryOf is the tsquery Search matches for the query text.
func TSQueryOf(text string) (string, error) {
	q, err := parseQuery(text)
	if err != nil {
		return "", err
	}
	return tsQuery(q.tokens), nil
}

// MatchSQL is the condition Search puts on the search columns of m for the
// query text, with its values as $1, $2 and so on.
func MatchSQL(text string) (string, []any, error) {
	q, err := parseQuery(text)
	if err != nil {
		return "", nil, err
	}
	st := &statement{}
	cond := q.match(st)
	return cond, st.args, nil
}
