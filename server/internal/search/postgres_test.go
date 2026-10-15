package search_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/search"
	"app.local/server/internal/store/testdb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

const tenant = "primary"

// seeded is a database with one searcher, member of every chat.
type seeded struct {
	pool  *pgxpool.Pool
	me    int64
	chats []int64
}

type seedMessage struct {
	chatIdx int
	date    time.Time
	text    string
}

// seed writes users, chats (me in all of them) and messages straight into
// the tables, with the search columns as the write paths store them.
func seed(t testing.TB, chats int, messages []seedMessage) seeded {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, tenant, "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	pool := st.Pool()
	const senders = 50
	var userRows [][]any
	for i := 1; i <= senders+1; i++ {
		userRows = append(userRows, []any{int64(i), tenant, fmt.Sprintf("acc_%d", i), fmt.Sprintf("user%03d", i), fmt.Sprintf("Người %d", i)})
	}
	copyRows(t, pool, "users", []string{"id", "tenant_id", "idp_sub", "username", "name"}, userRows)
	s := seeded{pool: pool, me: 1}
	var chatRows, memberRows [][]any
	for i := range chats {
		id := int64(1000 + i)
		s.chats = append(s.chats, id)
		chatRows = append(chatRows, []any{id, tenant, "group", fmt.Sprintf("Nhóm %d", i), int64(1)})
		memberRows = append(memberRows, []any{id, s.me})
	}
	copyRows(t, pool, "chats", []string{"id", "tenant_id", "type", "title", "creator_id"}, chatRows)
	copyRows(t, pool, "chat_members", []string{"chat_id", "user_id"}, memberRows)
	seqs := make([]int64, chats)
	var msgRows [][]any
	for i, m := range messages {
		seqs[m.chatIdx]++
		msgRows = append(msgRows, []any{s.chats[m.chatIdx], seqs[m.chatIdx], int64(i + 1), int64(2 + i%senders), m.date, m.text})
	}
	copyRows(t, pool, "messages", []string{"chat_id", "seq", "id", "from_id", "date", "text"}, msgRows)
	// The search columns as the backfill after a migration writes them.
	began := time.Now()
	n, err := search.Backfill(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil || n != len(messages) {
		t.Fatalf("backfill = %d, %v", n, err)
	}
	if len(messages) > 10_000 {
		t.Logf("backfill indexed %d messages in %s", n, time.Since(began).Round(time.Millisecond))
	}
	if _, err := pool.Exec(ctx, `UPDATE chats c SET last_seq = coalesce((SELECT max(seq) FROM messages m WHERE m.chat_id = c.id), 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE`); err != nil {
		t.Fatal(err)
	}
	return s
}

func copyRows(t testing.TB, pool *pgxpool.Pool, table string, columns []string, rows [][]any) {
	t.Helper()
	if _, err := pool.CopyFrom(context.Background(), pgx.Identifier{table}, columns, pgx.CopyFromRows(rows)); err != nil {
		t.Fatalf("copy %s: %v", table, err)
	}
}

func (s seeded) all(t testing.TB, p *search.Postgres, req search.Request) []search.Hit {
	t.Helper()
	req.TenantID, req.UserID = tenant, s.me
	var out []search.Hit
	for i := 0; ; i++ {
		page, err := p.Search(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		if page.NextCursor != "" && len(page.Hits) != req.Limit {
			t.Fatalf("page %d: %d hits of %d but not the last", i, len(page.Hits), req.Limit)
		}
		out = append(out, page.Hits...)
		if page.NextCursor == "" {
			return out
		}
		req.Cursor = page.NextCursor
		if i > 1000 {
			t.Fatal("endless cursor")
		}
	}
}

// Postgres keeps the lexemes exactly as vifold's tokens, and the query of
// each shared vector (spec/vi-fold) finds its own text.
func TestLexemesFollowSharedVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "vi-fold", "test-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Input  string   `json:"input"`
		Tokens []string `json:"tokens"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	pool := testdb.Open(t).Pool()
	ctx := context.Background()
	checked := 0
	for i, v := range vectors {
		if len(v.Tokens) == 0 || len(v.Tokens) > search.TokensMax {
			continue
		}
		f := search.FieldsOf("group", v.Input, nil)
		query, err := search.TSQueryOf(v.Input)
		if err != nil {
			t.Fatal(err)
		}
		var stored []string
		var found bool
		if err := pool.QueryRow(ctx, `SELECT tsvector_to_array(v), v @@ $2::tsquery FROM (SELECT `+search.TSVector("$1")+` AS v) x`,
			f.Lexemes, query).Scan(&stored, &found); err != nil {
			t.Fatalf("#%d %q: %v", i, v.Input, err)
		}
		want := slices.Compact(slices.Sorted(slices.Values(v.Tokens)))
		slices.Sort(stored)
		if !slices.Equal(stored, want) || !found {
			t.Errorf("#%d %q: lexemes %q (want %q), found by %s: %t", i, v.Input, stored, want, query, found)
		}
		checked++
	}
	if checked < 250 {
		t.Fatalf("only %d vectors checked", checked)
	}
}

// Across the edge of the rank window: exact-accent matches inside it come
// first, everything else keeps date order, and no page size repeats or
// loses a hit.
func TestRankWindowEdge(t *testing.T) {
	start := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	var messages []seedMessage
	for i := range 23 {
		text := fmt.Sprintf("ma %d", i)
		if i%3 != 0 {
			text = fmt.Sprintf("má %d", i)
		}
		messages = append(messages, seedMessage{chatIdx: i % 2, date: start.Add(time.Duration(i) * time.Minute), text: text})
	}
	s := seed(t, 2, messages)
	p := search.NewPostgres(s.pool)
	const window = 7
	search.SetRankWindow(p, window)

	// Expected: newest first; the window is the newest 7.
	type ranked struct {
		hit   search.Hit
		exact bool
	}
	var newest []ranked
	seqs := map[int]int64{}
	var byIndex []search.Hit
	for _, m := range messages {
		seqs[m.chatIdx]++
		byIndex = append(byIndex, search.Hit{ChatID: s.chats[m.chatIdx], Seq: seqs[m.chatIdx]})
	}
	for i := len(messages) - 1; i >= 0; i-- {
		newest = append(newest, ranked{hit: byIndex[i], exact: strings.HasPrefix(messages[i].text, "má")})
	}
	var want []search.Hit
	for i, r := range newest {
		if i < window && r.exact {
			want = append(want, r.hit)
		}
	}
	for i, r := range newest {
		if i >= window || !r.exact {
			want = append(want, r.hit)
		}
	}
	for limit := 1; limit <= 9; limit++ {
		if got := s.all(t, p, search.Request{Query: "má", Limit: limit}); !slices.Equal(got, want) {
			t.Fatalf("limit %d:\n got %v\nwant %v", limit, got, want)
		}
	}
	// Unaccented: date order only.
	var plain []search.Hit
	for _, r := range newest {
		plain = append(plain, r.hit)
	}
	if got := s.all(t, p, search.Request{Query: "ma", Limit: 4}); !slices.Equal(got, plain) {
		t.Fatalf("unaccented:\n got %v\nwant %v", got, plain)
	}
}

// vocabulary is the corpus of the latency test: common Vietnamese words of
// work chats.
var vocabulary = strings.Fields(`anh em chị mình bạn đã đang sẽ không có được làm việc họp
	báo cáo kế hoạch tuần tháng năm hôm nay mai qua sáng chiều tối nhé nha ạ ok xong rồi chưa
	gửi file ảnh tài liệu hợp đồng khách hàng dự án triển khai kiểm tra lỗi sửa bản phát hành
	server database postgres redis nginx deploy build test review merge nhánh chính lịch trực
	thiết kế màn hình đăng nhập giao diện người dùng đẹp nhanh chậm cao thấp mới cũ quan trọng
	gấp cần hỗ trợ giúp hỏi trả lời xem đọc viết nghe gọi điện thoại email tin nhắn nhóm kênh
	Hà Nội Đà Nẵng Sài Gòn Huế Cần Thơ văn phòng công ty phòng ban kỹ thuật vận hành kinh doanh
	tiền lương thưởng chi phí ngân sách hoá đơn thanh toán chuyển khoản nhận gửi trả đơn hàng
	cảm ơn xin lỗi chúc mừng sinh nhật ăn trưa cà phê nghỉ phép ốm về quê đi công tác`)

func sentence(r *rand.Rand) string {
	n := 4 + r.IntN(12)
	words := make([]string, n)
	for i := range words {
		words[i] = vocabulary[r.IntN(len(vocabulary))]
	}
	return strings.Join(words, " ")
}

// TestSearchLatency measures Search on 200,000 messages in 3,000 chats of one
// user (the phase 7 target: p50 ≤ 100 ms, p99 ≤ 500 ms). It seeds for about
// a minute, so it runs only with CHAT_SEARCH_PERF=1.
func TestSearchLatency(t *testing.T) {
	if os.Getenv("CHAT_SEARCH_PERF") == "" {
		t.Skip("set CHAT_SEARCH_PERF=1 to measure search latency")
	}
	const chats, total = 3000, 200_000
	r := rand.New(rand.NewPCG(7, 11))
	start := time.Now().Add(-365 * 24 * time.Hour)
	messages := make([]seedMessage, total)
	for i := range messages {
		// Skewed: a few busy chats, a long tail of quiet ones.
		chat := int(float64(chats) * r.Float64() * r.Float64())
		messages[i] = seedMessage{chatIdx: chat, date: start.Add(time.Duration(i) * 157 * time.Second), text: sentence(r)}
	}
	began := time.Now()
	s := seed(t, chats, messages)
	t.Logf("seeded %d messages in %d chats in %s", total, chats, time.Since(began).Round(time.Millisecond))
	p := search.NewPostgres(s.pool)

	type probe struct {
		name string
		req  search.Request
	}
	busiest := s.chats[0]
	probes := []probe{
		{"common word", search.Request{Query: "anh"}},
		{"common, accented", search.Request{Query: "báo cáo"}},
		{"phrase unaccented", search.Request{Query: "lich truc tuan"}},
		{"phrase accented", search.Request{Query: "kế hoạch triển khai"}},
		{"prefix while typing", search.Request{Query: "ng"}},
		{"word pair", search.Request{Query: "sinh nhat"}},
		{"place", search.Request{Query: "da nang"}},
		{"no match", search.Request{Query: "khongtontai"}},
		{"in busiest chat", search.Request{ChatID: busiest, Query: "deploy", Order: search.OrderNewest}},
		{"in quiet chat", search.Request{ChatID: s.chats[chats-1], Query: "hop", Order: search.OrderNewest}},
		{"sender filter", search.Request{Query: "loi", Filter: search.Filter{FromID: 7}}},
		{"date range", search.Request{Query: "server", Filter: search.Filter{Since: start.Add(100 * 24 * time.Hour), Until: start.Add(130 * 24 * time.Hour)}}},
	}
	ctx := context.Background()
	var all []time.Duration
	for _, pr := range probes {
		req := pr.req
		req.TenantID, req.UserID = tenant, s.me
		var times []time.Duration
		hits := 0
		for i := range 25 {
			at := time.Now()
			page, err := p.Search(ctx, req)
			if err != nil {
				t.Fatalf("%s: %v", pr.name, err)
			}
			times = append(times, time.Since(at))
			if i == 0 {
				hits = len(page.Hits)
				// The second page too: cursor queries are part of the load.
				if page.NextCursor != "" {
					next := req
					next.Cursor = page.NextCursor
					at := time.Now()
					if _, err := p.Search(ctx, next); err != nil {
						t.Fatalf("%s page 2: %v", pr.name, err)
					}
					times = append(times, time.Since(at))
				}
			}
		}
		all = append(all, times...)
		p50, p99 := percentile(times, 50), percentile(times, 99)
		t.Logf("%-20s hits %2d  p50 %6.1f ms  p99 %6.1f ms", pr.name, hits, ms(p50), ms(p99))
	}
	p50, p99 := percentile(all, 50), percentile(all, 99)
	t.Logf("ALL %d searches: p50 %.1f ms, p99 %.1f ms", len(all), ms(p50), ms(p99))
	if p50 > 100*time.Millisecond || p99 > 500*time.Millisecond {
		t.Fatalf("over budget: p50 %s (≤ 100 ms), p99 %s (≤ 500 ms)", p50, p99)
	}
}

func percentile(d []time.Duration, p int) time.Duration {
	s := slices.Clone(d)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	idx := (len(s)*p + 99) / 100
	return s[max(0, min(len(s)-1, idx-1))]
}

func ms(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

// The pool is an Execer for the backfill.
var _ search.Execer = (*pgxpool.Pool)(nil)
