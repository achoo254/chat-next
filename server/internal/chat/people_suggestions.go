package chat

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/vifold"
)

// userPair is two users, the lower id first.
type userPair struct{ a, b int64 }

// ListLinkSuggestions computes the pairs of candidates that may be the same
// person. Strong: the other apps show the same phone number for both (equal
// keyed hashes; only puppets have one). Weak: equal names after folding case,
// accents and spaces. Phone suggestions come first; a pair that matches both is
// listed once, by phone. Pairs already in one person or rejected are left out.
// Two Chat accounts, or two puppets of the same bridge account, are never
// suggested: one person has one identity per account (manual linking stays open
// for them). userID, when not 0, keeps only the pairs that involve that user.
// Nothing is ever linked here: the owner confirms every suggestion.
func (s *Service) ListLinkSuggestions(ctx context.Context, me, userID int64) ([]*appv1.LinkSuggestion, error) {
	peers, err := s.peersOf(ctx, s.pool, me, nil)
	if err != nil {
		return nil, err
	}
	if userID != 0 {
		if _, ok := peers[userID]; !ok {
			return nil, errNotFound("user")
		}
	}
	inPerson, err := s.personOfUsers(ctx, me)
	if err != nil {
		return nil, err
	}
	rejected, err := s.rejectedPairs(ctx, me)
	if err != nil {
		return nil, err
	}

	ordered := make([]peer, 0, len(peers))
	for _, p := range peers {
		ordered = append(ordered, p)
	}
	slices.SortFunc(ordered, func(x, y peer) int { return cmp.Compare(x.ID, y.ID) })
	byPhone := map[string][]peer{}
	byName := map[string][]peer{}
	for _, p := range ordered {
		if len(p.Phone) > 0 {
			byPhone[string(p.Phone)] = append(byPhone[string(p.Phone)], p)
		}
		if key := vifold.Fold(strings.TrimSpace(p.Name)); key != "" {
			byName[key] = append(byName[key], p)
		}
	}
	seen := map[userPair]bool{}
	suggest := func(groups map[string][]peer, reason appv1.LinkSuggestionReason) []*appv1.LinkSuggestion {
		var out []*appv1.LinkSuggestion
		for _, group := range groups {
			for i, x := range group {
				for _, y := range group[i+1:] {
					pair := userPair{x.ID, y.ID}
					switch {
					case seen[pair], rejected[pair]:
						continue
					case userID != 0 && x.ID != userID && y.ID != userID:
						continue
					case (x.App == "" && y.App == "") || (x.Acct != 0 && x.Acct == y.Acct):
						continue
					}
					if px, ok := inPerson[x.ID]; ok && px == inPerson[y.ID] {
						continue
					}
					seen[pair] = true
					out = append(out, &appv1.LinkSuggestion{First: x.member(), Second: y.member(), Reason: reason})
				}
			}
		}
		slices.SortFunc(out, func(x, y *appv1.LinkSuggestion) int {
			return cmp.Or(cmp.Compare(x.First.UserId, y.First.UserId), cmp.Compare(x.Second.UserId, y.Second.UserId))
		})
		return out
	}
	strong := suggest(byPhone, appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_PHONE)
	return append(strong, suggest(byName, appv1.LinkSuggestionReason_LINK_SUGGESTION_REASON_NAME)...), nil
}

// personOfUsers maps each user in one of owner's people to that person.
func (s *Service) personOfUsers(ctx context.Context, owner int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	rows, err := s.pool.Query(ctx, `SELECT user_id, person_id FROM people_members WHERE owner_id = $1`, owner)
	if err != nil {
		return nil, fmt.Errorf("chat: link suggestions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var u, p int64
		if err := rows.Scan(&u, &p); err != nil {
			return nil, fmt.Errorf("chat: link suggestions: %w", err)
		}
		out[u] = p
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: link suggestions: %w", err)
	}
	return out, nil
}

// rejectedPairs are the pairs owner said are not the same person.
func (s *Service) rejectedPairs(ctx context.Context, owner int64) (map[userPair]bool, error) {
	out := map[userPair]bool{}
	rows, err := s.pool.Query(ctx, `SELECT user_a, user_b FROM people_rejections WHERE owner_id = $1`, owner)
	if err != nil {
		return nil, fmt.Errorf("chat: link suggestions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p userPair
		if err := rows.Scan(&p.a, &p.b); err != nil {
			return nil, fmt.Errorf("chat: link suggestions: %w", err)
		}
		out[p] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: link suggestions: %w", err)
	}
	return out, nil
}
