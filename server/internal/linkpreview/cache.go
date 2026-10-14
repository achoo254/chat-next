package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
)

// Cache lifetimes: a good preview is reused for a day, a failed fetch is not
// retried for an hour.
const (
	okTTL   = 24 * time.Hour
	failTTL = time.Hour
	// retention is how long rows stay before Purge drops them.
	retention = 7 * 24 * time.Hour
)

// Service serves previews from the link_previews cache, fetching on a miss.
// Concurrent misses of one URL share a single fetch.
type Service struct {
	pool    *pgxpool.Pool
	fetcher *Fetcher
	group   singleflight.Group
	logger  *slog.Logger
}

// NewService returns a cache over pool that fetches with fetcher.
func NewService(pool *pgxpool.Pool, fetcher *Fetcher, logger *slog.Logger) *Service {
	return &Service{pool: pool, fetcher: fetcher, logger: logger}
}

// Cached returns the cached preview of a normalized URL without fetching.
// found is false on a miss or an expired entry; an entry for a page without
// a preview is found with an empty Preview.
func (s *Service) Cached(ctx context.Context, normalized string) (p Preview, found bool, err error) {
	var ok bool
	var fetchedAt time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT ok, site_name, title, description, fetched_at FROM link_previews WHERE url = $1`, normalized).
		Scan(&ok, &p.SiteName, &p.Title, &p.Description, &fetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preview{}, false, nil
	}
	if err != nil {
		return Preview{}, false, fmt.Errorf("linkpreview: read cache: %w", err)
	}
	ttl := okTTL
	if !ok {
		ttl = failTTL
	}
	if time.Since(fetchedAt) > ttl {
		return Preview{}, false, nil
	}
	if !ok {
		return Preview{}, true, nil
	}
	p.URL = normalized
	return p, true, nil
}

// Get returns the preview of a normalized URL, fetching and caching it on a
// miss. A page that cannot be fetched or has no preview yields an empty
// Preview and no error; errors are reserved for the cache itself.
func (s *Service) Get(ctx context.Context, normalized string) (Preview, error) {
	if p, found, err := s.Cached(ctx, normalized); err != nil || found {
		return p, err
	}
	v, err, _ := s.group.Do(normalized, func() (any, error) {
		// Detached: one caller giving up must not cancel the shared fetch.
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), DefaultTimeout+time.Second)
		defer cancel()
		p, ferr := s.fetcher.Fetch(fctx, normalized)
		if ferr != nil {
			s.logger.Debug("link preview fetch failed", "err", ferr)
			p = Preview{}
		}
		ok := ferr == nil && !p.Empty()
		if _, err := s.pool.Exec(fctx, `
			INSERT INTO link_previews (url, ok, site_name, title, description, fetched_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (url) DO UPDATE SET ok = excluded.ok, site_name = excluded.site_name,
				title = excluded.title, description = excluded.description, fetched_at = excluded.fetched_at`,
			normalized, ok, p.SiteName, p.Title, p.Description); err != nil {
			return Preview{}, fmt.Errorf("linkpreview: write cache: %w", err)
		}
		if !ok {
			return Preview{}, nil
		}
		p.URL = normalized
		return p, nil
	})
	if err != nil {
		return Preview{}, err
	}
	p, _ := v.(Preview)
	return p, nil
}

// Purge drops cache rows older than the retention.
func (s *Service) Purge(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM link_previews WHERE fetched_at < now() - $1::interval`, retention)
	if err != nil {
		return fmt.Errorf("linkpreview: purge: %w", err)
	}
	return nil
}
