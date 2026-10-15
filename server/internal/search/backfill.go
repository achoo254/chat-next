package search

import (
	"context"
	"fmt"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/protobuf/proto"
)

// backfillBatch is how many messages one backfill step indexes.
const backfillBatch = 500

// Execer runs statements and queries: a connection or a pool.
type Execer interface {
	Querier
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Backfill writes the search columns of every message that misses one
// (search_tsv or search_text NULL): the rows from before the search columns
// existed and rows a previous binary wrote after the migration. It is
// idempotent and walks the table once in primary key order.
func Backfill(ctx context.Context, db Execer, logger *slog.Logger) (int, error) {
	type pending struct {
		chatID, seq int64
		chatType    string
		text        string
		content     []byte
		deleted     bool
	}
	var lastChat, lastSeq int64
	total := 0
	for {
		rows, err := db.Query(ctx, `
			SELECT m.chat_id, m.seq, coalesce(c.type, ''), m.text, m.content, m.deleted_at IS NOT NULL
			FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
			WHERE (m.search_tsv IS NULL OR m.search_text IS NULL) AND (m.chat_id, m.seq) > ($1, $2)
			ORDER BY m.chat_id, m.seq LIMIT $3`, lastChat, lastSeq, backfillBatch)
		if err != nil {
			return total, fmt.Errorf("search: backfill: %w", err)
		}
		batch, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (pending, error) {
			var p pending
			err := r.Scan(&p.chatID, &p.seq, &p.chatType, &p.text, &p.content, &p.deleted)
			return p, err
		})
		if err != nil {
			return total, fmt.Errorf("search: backfill: %w", err)
		}
		if len(batch) == 0 {
			break
		}
		chats := make([]int64, len(batch))
		seqs := make([]int64, len(batch))
		lexemes := make([]string, len(batch))
		texts := make([]string, len(batch))
		kinds := make([]int16, len(batch))
		links := make([]bool, len(batch))
		for i, p := range batch {
			chats[i], seqs[i] = p.chatID, p.seq
			if p.deleted {
				continue
			}
			content := &appv1.Message{}
			if len(p.content) > 0 {
				if err := proto.Unmarshal(p.content, content); err != nil {
					// An undecodable row is indexed by its text alone rather
					// than blocking the backfill.
					logger.Warn("search backfill: undecodable message content", "chat_id", p.chatID, "seq", p.seq, "err", err)
					content = &appv1.Message{}
				}
			}
			if content.GetAction() != nil {
				continue
			}
			f := FieldsOf(p.chatType, p.text, content)
			lexemes[i], texts[i], kinds[i], links[i] = f.Lexemes, f.Text, f.MediaKind, f.HasLink
		}
		if _, err := db.Exec(ctx, `
			UPDATE messages m SET search_tsv = `+TSVector("x.lexemes")+`, search_text = x.search_text,
				media_kind = x.media_kind, has_link = x.has_link
			FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::smallint[], $6::boolean[])
				AS x(chat_id, seq, lexemes, search_text, media_kind, has_link)
			WHERE m.chat_id = x.chat_id AND m.seq = x.seq AND (m.search_tsv IS NULL OR m.search_text IS NULL)`,
			chats, seqs, lexemes, texts, kinds, links); err != nil {
			return total, fmt.Errorf("search: backfill: %w", err)
		}
		total += len(batch)
		last := batch[len(batch)-1]
		lastChat, lastSeq = last.chatID, last.seq
	}
	if total > 0 {
		logger.Info("search backfill done", "messages", total)
	}
	return total, nil
}
