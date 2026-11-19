package chat

import (
	"context"
	"fmt"
)

// ImportedMember is a person of the other app as a member of the chat: their
// puppet user and whether they are an admin there.
type ImportedMember struct {
	UserID int64
	Admin  bool
	// Perms is the restriction of the member as ChatPermission bits; nil for none.
	Perms *uint32
}

// SyncMembers makes the puppets that are members of the chat match who the other
// app says is in the group: the ones listed join (or rejoin) and take the role they
// have there, the ones not listed leave. complete says the list is the whole group;
// without it nobody is removed. The owner and every user who is not a puppet are
// never touched: Chat-only members stay members, and the owner is not demoted by
// the other app. It reports whether anything changed.
//
// It asks for no right and posts no system line: who joined, left or was removed is
// said by the other app's own system lines, imported with its messages.
func (it *ImportTx) SyncMembers(ctx context.Context, members []ImportedMember, complete bool) (bool, error) {
	if it.c.Type == typePrivate {
		return false, nil
	}
	changed := false
	want := make(map[int64]bool, len(members))
	for _, m := range members {
		if m.UserID == it.owner {
			continue
		}
		want[m.UserID] = m.Admin
		role := roleMember
		if m.Admin {
			role = roleAdmin
		}
		tag, err := it.t.tx.Exec(ctx, `
			INSERT INTO chat_members (chat_id, user_id, role, inviter_id) VALUES ($1, $2, $3, $4)
			ON CONFLICT (chat_id, user_id) DO UPDATE
				SET left_at = NULL, left_seq = NULL, banned_at = NULL, banned_by = NULL, role = EXCLUDED.role, permissions = NULL
				WHERE chat_members.role <> 'owner' AND (chat_members.left_at IS NOT NULL OR chat_members.role <> EXCLUDED.role)
				AND EXISTS (SELECT 1 FROM external_users x WHERE x.user_id = chat_members.user_id)`,
			it.c.ID, m.UserID, role, it.owner)
		if err != nil {
			return false, fmt.Errorf("chat: sync imported member: %w", err)
		}
		if tag.RowsAffected() > 0 {
			changed = true
		}
		if !m.Admin {
			var want any
			if m.Perms != nil {
				want = int32(*m.Perms & allPerms)
			}
			ptag, err := it.t.tx.Exec(ctx, `
				UPDATE chat_members SET permissions = $3 WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL AND role = 'member'
				AND permissions IS DISTINCT FROM $3::int
				AND EXISTS (SELECT 1 FROM external_users x WHERE x.user_id = chat_members.user_id)`, it.c.ID, m.UserID, want)
			if err != nil {
				return false, fmt.Errorf("chat: sync imported member rights: %w", err)
			}
			if ptag.RowsAffected() > 0 {
				changed = true
			}
		}
	}
	if complete {
		rows, err := it.t.tx.Query(ctx, `
			SELECT m.user_id FROM chat_members m JOIN external_users x ON x.user_id = m.user_id
			WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.role <> 'owner'`, it.c.ID)
		if err != nil {
			return false, fmt.Errorf("chat: imported members: %w", err)
		}
		var gone []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return false, fmt.Errorf("chat: imported members: %w", err)
			}
			if _, ok := want[id]; !ok {
				gone = append(gone, id)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return false, fmt.Errorf("chat: imported members: %w", err)
		}
		for _, id := range gone {
			// No line of its own: the other app's system line (imported with the
			// messages) says who left or was removed.
			if err := it.t.removeMember(ctx, it.c, 0, id, false); err != nil {
				return false, err
			}
			changed = true
		}
	}
	if changed {
		if err := it.t.tx.QueryRow(ctx, `
			UPDATE chats SET member_count = (SELECT count(*) FROM chat_members WHERE chat_id = $1 AND left_at IS NULL), updated_at = now()
			WHERE id = $1 RETURNING member_count`, it.c.ID).Scan(&it.c.MemberCount); err != nil {
			return false, fmt.Errorf("chat: count members: %w", err)
		}
		if err := it.t.chatChanged(ctx, it.c, it.owner); err != nil {
			return false, err
		}
	}
	return changed, nil
}
