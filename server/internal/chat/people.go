package chat

import (
	"context"
	"fmt"
	"slices"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// People (ADR 0025): the owner's grouping of users that are the same person
// on several apps. Everything here is scoped to the caller. A user the caller
// has no live private chat with is NotFound, whether or not they exist, so
// the ids of other people's users cannot be probed (the rule of GetUsers).

const (
	// peopleLinkMax is how many users one LinkUsers call may name.
	peopleLinkMax = 20
	// personNameMax is the byte limit of people.name (the column CHECK).
	personNameMax = 256
)

// peer is a user the owner has a live private chat with.
type peer struct {
	ID     int64
	Name   string
	App    string // "telegram", ...; empty for a Chat account
	Acct   int64  // the bridge account of a puppet; 0 for a Chat account
	ChatID int64
	// Phone is the keyed hash of the phone number the other app shows for a
	// puppet (external_users.phone_hmac); nil when unknown. Never sent out.
	Phone []byte
}

func (p peer) member() *appv1.PersonMember {
	return &appv1.PersonMember{UserId: p.ID, Name: p.Name, App: p.App, ChatId: p.ChatID}
}

// peersOf returns the candidates of owner: users with a private chat that is
// not deleted (the chat with oneself and bots are left out), keyed by id.
// ids narrows the lookup; nil means all of them.
func (s *Service) peersOf(ctx context.Context, q querier, owner int64, ids []int64) (map[int64]peer, error) {
	rows, err := q.Query(ctx, `
		SELECT u.id, u.name, coalesce(u.external_source, ''), coalesce(eu.account_id, 0), p.chat_id, eu.phone_hmac
		FROM private_chats p
		JOIN chats c ON c.id = p.chat_id AND c.deleted_at IS NULL
		JOIN users u ON u.id = CASE WHEN p.user_low = $2 THEN p.user_high ELSE p.user_low END
		LEFT JOIN external_users eu ON eu.user_id = u.id
		WHERE p.tenant_id = $1 AND $2 IN (p.user_low, p.user_high) AND p.user_low <> p.user_high
		  AND u.tenant_id = $1 AND u.deleted_at IS NULL AND NOT u.is_bot
		  AND ($3 OR u.id = ANY($4))`,
		s.cfg.TenantID, owner, ids == nil, ids)
	if err != nil {
		return nil, fmt.Errorf("chat: people candidates: %w", err)
	}
	defer rows.Close()
	out := map[int64]peer{}
	for rows.Next() {
		var p peer
		if err := rows.Scan(&p.ID, &p.Name, &p.App, &p.Acct, &p.ChatID, &p.Phone); err != nil {
			return nil, fmt.Errorf("chat: people candidates: %w", err)
		}
		out[p.ID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: people candidates: %w", err)
	}
	return out, nil
}

// lockPeople serializes the people operations of one owner for the rest of
// the transaction, so two sessions linking and unlinking at once see each
// other's work and cannot deadlock on person rows.
func lockPeople(ctx context.Context, tx pgx.Tx, owner int64) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('people:' || ($1::bigint)::text, 0))`, owner); err != nil {
		return fmt.Errorf("chat: lock people: %w", err)
	}
	return nil
}

// announcePeopleChanged tells every session of owner to list their people again.
func announcePeopleChanged(t *txn, owner int64) {
	t.toUsers(t.event(kindPeopleChanged, 0, owner), []int64{owner}, &appv1.Update{
		Kind: &appv1.Update_PeopleChanged{PeopleChanged: &appv1.UpdatePeopleChanged{}},
	})
}

// clipBytes cuts s to at most n bytes without splitting a character.
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// ListPeople returns the caller's people, each with the users in it that
// still exist. A member whose private chat is gone keeps chat_id 0.
func (s *Service) ListPeople(ctx context.Context, me int64) ([]*appv1.Person, error) {
	return s.peopleOf(ctx, s.pool, me, 0)
}

// peopleOf lists the people of owner, or just the person with id only when
// only is not 0.
func (s *Service) peopleOf(ctx context.Context, q querier, owner, only int64) ([]*appv1.Person, error) {
	rows, err := q.Query(ctx, `
		SELECT p.id, p.name, u.id, u.name, coalesce(u.external_source, ''), coalesce(pc.chat_id, 0)
		FROM people p
		JOIN people_members m ON m.person_id = p.id
		JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
		LEFT JOIN (
			SELECT c.id AS chat_id, p2.user_low, p2.user_high
			FROM private_chats p2 JOIN chats c ON c.id = p2.chat_id AND c.deleted_at IS NULL
			WHERE p2.tenant_id = $3
		) pc ON pc.user_low = least($1::bigint, u.id) AND pc.user_high = greatest($1::bigint, u.id)
		WHERE p.owner_id = $1 AND ($2::bigint = 0 OR p.id = $2::bigint)
		ORDER BY p.id, m.created_at, u.id`, owner, only, s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("chat: list people: %w", err)
	}
	defer rows.Close()
	var out []*appv1.Person
	for rows.Next() {
		var id, userID, chatID int64
		var name, userName, app string
		if err := rows.Scan(&id, &name, &userID, &userName, &app, &chatID); err != nil {
			return nil, fmt.Errorf("chat: list people: %w", err)
		}
		if len(out) == 0 || out[len(out)-1].Id != id {
			out = append(out, &appv1.Person{Id: id, Name: name})
		}
		last := out[len(out)-1]
		last.Members = append(last.Members, &appv1.PersonMember{UserId: userID, Name: userName, App: app, ChatId: chatID})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: list people: %w", err)
	}
	return out, nil
}

// LinkUsers joins the named users into one person of the caller. Users that
// already belong to people merge those people into the one with the lowest
// id. Every user must be a candidate (a private chat with the caller), checked
// in the same transaction as the write.
func (s *Service) LinkUsers(ctx context.Context, me int64, req *appv1.LinkUsersRequest) (*appv1.Person, error) {
	var ids []int64
	for _, id := range req.GetUserIds() {
		if id <= 0 {
			return nil, errInvalid("user_ids must be positive")
		}
		if id == me {
			return nil, errInvalid("you cannot link yourself")
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) < 2 {
		return nil, errInvalid("two or more different users are needed")
	}
	if len(ids) > peopleLinkMax {
		return nil, errInvalid("at most %d users", peopleLinkMax)
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	var out *appv1.Person
	_, err := s.inTx(ctx, func(t *txn) error {
		if err := lockPeople(ctx, t.tx, me); err != nil {
			return err
		}
		peers, err := s.peersOf(ctx, t.tx, me, ids)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, ok := peers[id]; !ok {
				return errNotFound("user")
			}
		}
		rows, err := t.tx.Query(ctx, `SELECT DISTINCT person_id FROM people_members WHERE owner_id = $1 AND user_id = ANY($2) ORDER BY person_id`, me, ids)
		if err != nil {
			return fmt.Errorf("chat: find people to link: %w", err)
		}
		existing, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return fmt.Errorf("chat: find people to link: %w", err)
		}
		var personID int64
		if len(existing) == 0 {
			if err := t.tx.QueryRow(ctx, `INSERT INTO people (owner_id, name) VALUES ($1, $2) RETURNING id`,
				me, clipBytes(pinnedName(ids, peers), personNameMax)).Scan(&personID); err != nil {
				return fmt.Errorf("chat: create person: %w", err)
			}
		} else {
			personID = existing[0]
			if others := existing[1:]; len(others) > 0 {
				if _, err := t.tx.Exec(ctx, `UPDATE people_members SET person_id = $1 WHERE owner_id = $2 AND person_id = ANY($3)`, personID, me, others); err != nil {
					return fmt.Errorf("chat: merge people: %w", err)
				}
				if _, err := t.tx.Exec(ctx, `DELETE FROM people WHERE owner_id = $1 AND id = ANY($2)`, me, others); err != nil {
					return fmt.Errorf("chat: merge people: %w", err)
				}
			}
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO people_members (person_id, owner_id, user_id) SELECT $1, $2, u FROM unnest($3::bigint[]) u
			ON CONFLICT (person_id, user_id) DO NOTHING`, personID, me, ids); err != nil {
			return fmt.Errorf("chat: add people members: %w", err)
		}
		// A pair now inside one person cannot be rejected as «not the same».
		if _, err := t.tx.Exec(ctx, `
			DELETE FROM people_rejections WHERE owner_id = $1
			  AND user_a IN (SELECT user_id FROM people_members WHERE person_id = $2)
			  AND user_b IN (SELECT user_id FROM people_members WHERE person_id = $2)`, me, personID); err != nil {
			return fmt.Errorf("chat: clear rejections: %w", err)
		}
		announcePeopleChanged(t, me)
		people, err := s.peopleOf(ctx, t.tx, me, personID)
		if err != nil {
			return err
		}
		if len(people) != 1 {
			return fmt.Errorf("chat: linked person %d is not listed", personID)
		}
		out = people[0]
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("users linked", "owner_id", me, "person_id", out.Id, "members", len(out.Members))
	return out, nil
}

// pinnedName is the name a new person keeps: the Chat account's if one is
// linked (the request order breaks ties), else the first user's.
func pinnedName(ids []int64, peers map[int64]peer) string {
	for _, id := range ids {
		if p := peers[id]; p.App == "" && p.Name != "" {
			return p.Name
		}
	}
	for _, id := range ids {
		if p := peers[id]; p.Name != "" {
			return p.Name
		}
	}
	return ""
}

// UnlinkUser takes a user out of their person; a person left with fewer than
// two users is removed. A user who is not in a person is a no-op, since only
// the caller's own rows are ever touched.
func (s *Service) UnlinkUser(ctx context.Context, me, userID int64) error {
	if userID <= 0 {
		return errInvalid("user_id is required")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return err
	}
	changed := false
	_, err := s.inTx(ctx, func(t *txn) error {
		if err := lockPeople(ctx, t.tx, me); err != nil {
			return err
		}
		var personID int64
		err := t.tx.QueryRow(ctx, `DELETE FROM people_members WHERE owner_id = $1 AND user_id = $2 RETURNING person_id`, me, userID).Scan(&personID)
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("chat: unlink user: %w", err)
		}
		changed = true
		if _, err := t.tx.Exec(ctx, `
			DELETE FROM people WHERE id = $1 AND owner_id = $2
			  AND (SELECT count(*) FROM people_members WHERE person_id = $1) < 2`, personID, me); err != nil {
			return fmt.Errorf("chat: drop a person left alone: %w", err)
		}
		announcePeopleChanged(t, me)
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		s.logger.Info("user unlinked", "owner_id", me, "user_id", userID)
	}
	return nil
}

// RejectLinkSuggestion records that two candidates are not the same person,
// so the pair is not suggested again.
func (s *Service) RejectLinkSuggestion(ctx context.Context, me, a, b int64) error {
	if a <= 0 || b <= 0 || a == b || a == me || b == me {
		return errInvalid("two different users, neither the caller, are needed")
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return err
	}
	low, high := min(a, b), max(a, b)
	_, err := s.inTx(ctx, func(t *txn) error {
		if err := lockPeople(ctx, t.tx, me); err != nil {
			return err
		}
		peers, err := s.peersOf(ctx, t.tx, me, []int64{a, b})
		if err != nil {
			return err
		}
		if _, ok := peers[a]; !ok {
			return errNotFound("user")
		}
		if _, ok := peers[b]; !ok {
			return errNotFound("user")
		}
		tag, err := t.tx.Exec(ctx, `INSERT INTO people_rejections (owner_id, user_a, user_b) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, me, low, high)
		if err != nil {
			return fmt.Errorf("chat: reject link suggestion: %w", err)
		}
		if tag.RowsAffected() > 0 {
			announcePeopleChanged(t, me)
		}
		return nil
	})
	return err
}

// DetachBridgeAccount takes the puppets of a bridge account out of the
// owner's people and drops the rejections that name them, inside tx (the
// transaction that removes the account); a person left with fewer than two
// users goes with them. Callers announce the change after the commit
// (AnnouncePeopleChanged).
func (s *Service) DetachBridgeAccount(ctx context.Context, tx pgx.Tx, owner, accountID int64) error {
	if err := lockPeople(ctx, tx, owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM people_members m USING external_users eu WHERE eu.account_id = $1 AND m.user_id = eu.user_id`, accountID); err != nil {
		return fmt.Errorf("chat: detach puppets from people: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM people_rejections r USING external_users eu
		WHERE eu.account_id = $1 AND (r.user_a = eu.user_id OR r.user_b = eu.user_id)`, accountID); err != nil {
		return fmt.Errorf("chat: drop rejections of puppets: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM people p WHERE p.owner_id = $1
		  AND (SELECT count(*) FROM people_members m WHERE m.person_id = p.id) < 2`, owner); err != nil {
		return fmt.Errorf("chat: drop people left alone: %w", err)
	}
	return nil
}

// AnnouncePeopleChanged tells every session of owner to list their people
// again, for a change made outside this package (a removed bridge account).
func (s *Service) AnnouncePeopleChanged(ctx context.Context, owner int64) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		announcePeopleChanged(t, owner)
		return nil
	})
	return err
}
