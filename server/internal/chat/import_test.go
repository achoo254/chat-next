package chat

import (
	"context"
	"errors"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

// puppet makes a puppet user (a contact of another app) and adds it to chatID.
func (h *harness) puppet(chatID int64, name string) int64 {
	h.t.Helper()
	ctx := context.Background()
	id, err := store.NextUserID(ctx, h.st.Pool())
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `
		INSERT INTO users (id, tenant_id, idp_sub, username, name, external_source) VALUES ($1, $2, NULL, $3, $4, 'telegram')`,
		id, h.svc.cfg.TenantID, "ext_"+name, name); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, chatID, id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) importInto(chatID, owner int64, fn func(*ImportTx) error) error {
	return h.svc.WithImport(context.Background(), chatID, owner, fn)
}

func TestImportAppendKeepsOrderDatesAndSkipsPuppets(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	// A chat made for an import starts with no activity, so it is listed by
	// the dates of what is imported, not by when it was created.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET last_message_at = 'epoch' WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().Add(-72 * time.Hour).Truncate(time.Second)
	var seqs []int64
	err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{
			{FromID: pup, Date: t0, Text: "một"},
			{FromID: owner, Date: t0.Add(time.Hour), Text: "hai"},
			{FromID: pup, Date: t0.Add(2 * time.Hour), Text: "ba", ReplyToSeq: 0},
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(seqs) != 3 || seqs[0] >= seqs[1] || seqs[1] >= seqs[2] {
		t.Fatalf("seqs = %v, want three increasing", seqs)
	}
	var date time.Time
	if err := h.st.Pool().QueryRow(ctx, `SELECT date FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seqs[1]).Scan(&date); err != nil {
		t.Fatal(err)
	}
	if !date.Equal(t0.Add(time.Hour)) {
		t.Fatalf("date = %v, want the original %v", date, t0.Add(time.Hour))
	}
	var last time.Time
	if err := h.st.Pool().QueryRow(ctx, `SELECT last_message_at FROM chats WHERE id = $1`, chatID).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if !last.Equal(t0.Add(2 * time.Hour)) {
		t.Fatalf("last_message_at = %v, want the newest message date %v", last, t0.Add(2*time.Hour))
	}
	var puppetLogs int
	if err := h.st.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM user_state WHERE user_id = $1) + (SELECT count(*) FROM user_updates WHERE user_id = $1)`, pup).Scan(&puppetLogs); err != nil {
		t.Fatal(err)
	}
	if puppetLogs != 0 {
		t.Fatalf("puppet has %d log rows, want none", puppetLogs)
	}
	var read int64
	if err := h.st.Pool().QueryRow(ctx, `SELECT read_inbox_max_seq FROM chat_read_states WHERE chat_id = $1 AND user_id = $2 AND topic_id = 0`, chatID, owner).Scan(&read); err != nil {
		t.Fatal(err)
	}
	if read != seqs[2] {
		t.Fatalf("owner read position = %d, want %d (nothing unread)", read, seqs[2])
	}
	var silent int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM messages WHERE chat_id = $1 AND from_id IN ($2, $3) AND text <> '' AND content IS NOT NULL`, chatID, pup, owner).Scan(&silent); err != nil {
		t.Fatal(err)
	}
	if silent != 3 {
		t.Fatalf("%d imported messages carry the silent content, want 3", silent)
	}
	log := h.logOf(owner)
	if len(log) < 3 {
		t.Fatalf("owner log has %d updates, want one per message", len(log))
	}
	// Each imported message reaches the owner's sessions as a new, unread
	// message; the last update must tell them nothing is unread.
	told := log[len(log)-1].GetRead()
	if told == nil || told.GetMaxSeq() != seqs[2] || told.GetUnreadCount() != 0 || told.GetUnreadMentionsCount() != 0 || told.GetOutbox() {
		t.Fatalf("last owner update = %v, want an inbox read up to %d with no unread", log[len(log)-1], seqs[2])
	}
}

func TestImportDateNeverAfterNow(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	future := time.Now().Add(48 * time.Hour)
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{{FromID: pup, Date: future, Text: "from the future"}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var date time.Time
	if err := h.st.Pool().QueryRow(ctx, `SELECT date FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seqs[0]).Scan(&date); err != nil {
		t.Fatal(err)
	}
	if date.After(time.Now()) {
		t.Fatalf("date %v is in the future", date)
	}
}

func TestImportEditDeleteAndReply(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	old := time.Now().Add(-30 * 24 * time.Hour)
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{{FromID: pup, Date: old, Text: "gốc"}, {FromID: pup, Date: old, Text: "xoá tôi"}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// An edit of a month-old message by another user's puppet is allowed, and
	// an identical edit changes nothing.
	for i, want := range []bool{true, false} {
		var changed bool
		if err := h.importInto(chatID, owner, func(it *ImportTx) error {
			var err error
			changed, err = it.Edit(ctx, seqs[0], ImportMessage{FromID: pup, Text: "đã sửa"})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if changed != want {
			t.Fatalf("edit %d changed = %v, want %v", i, changed, want)
		}
	}
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		if err := it.SetReply(ctx, seqs[1], seqs[0]); err != nil {
			return err
		}
		return it.Delete(ctx, []int64{seqs[1], 9999})
	}); err != nil {
		t.Fatal(err)
	}
	var text string
	var edited bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT text, edit_date IS NOT NULL FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seqs[0]).Scan(&text, &edited); err != nil {
		t.Fatal(err)
	}
	if text != "đã sửa" || !edited {
		t.Fatalf("message = %q edited=%v", text, edited)
	}
	var gone bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM messages WHERE chat_id = $1 AND seq = $2`, chatID, seqs[1]).Scan(&gone); err != nil {
		t.Fatal(err)
	}
	if !gone {
		t.Fatal("deleted message is still live")
	}
}

func TestImportDropsMentionsOfNonMembers(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	other := h.user("other")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	text := "chào anh"
	ents := []*appv1.MessageEntity{{Type: appv1.EntityType_ENTITY_TYPE_MENTION_NAME, Offset: 5, Length: 3, UserId: other}}
	var seqs []int64
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		var err error
		seqs, err = it.Append(ctx, []ImportMessage{{FromID: pup, Date: time.Now(), Text: text, Entities: ents}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM message_mentions WHERE chat_id = $1 AND seq = $2`, chatID, seqs[0]).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d mention rows for a non-member, want none", n)
	}
}

func TestImportRefusesGoneOrForeignChat(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	stranger := h.user("stranger")
	chatID := h.group(owner)
	if err := h.importInto(chatID, stranger, func(*ImportTx) error { return nil }); !errors.Is(err, ErrImportChatGone) {
		t.Fatalf("non-member import = %v, want ErrImportChatGone", err)
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET deleted_at = now() WHERE id = $1`, chatID); err != nil {
		t.Fatal(err)
	}
	if err := h.importInto(chatID, owner, func(*ImportTx) error { return nil }); !errors.Is(err, ErrImportChatGone) {
		t.Fatalf("deleted chat import = %v, want ErrImportChatGone", err)
	}
}

func TestPuppetsAreNotFindableMessageableOrAddable(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	stranger := h.user("stranger")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	// The username is changed to one that is valid, so the lookups below test the
	// filter on external_source and not the reserved prefix.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET name = 'Lan Anh', username = 'lananh' WHERE id = $1`, pup); err != nil {
		t.Fatal(err)
	}
	if users, err := h.svc.SearchUsers(ctx, stranger, "lananh", 10); err != nil || len(users) != 0 {
		t.Fatalf("SearchUsers found the puppet: %v, %v", users, err)
	}
	if _, err := h.svc.ResolveUsername(ctx, stranger, "lananh"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("ResolveUsername = %v, want NotFound", err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, stranger, pup); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("CreatePrivate = %v, want NotFound", err)
	}
	if _, err := h.svc.AddContact(ctx, owner, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: pup}}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("AddContact of a puppet the owner shares a chat with = %v, want NotFound", err)
	}
	other := h.group(stranger)
	resp, err := h.svc.AddMembers(ctx, stranger, other, []int64{pup})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.GetFailedUserIds()) != 1 || resp.GetFailedUserIds()[0] != pup {
		t.Fatalf("AddMembers failed = %v, want the puppet refused", resp.GetFailedUserIds())
	}
}

func TestLinkedChatRefusesSending(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	h.send(owner, chatID, "before linking")
	var accountID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-1', '\x00') RETURNING id`, owner).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.st.Pool().Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id) VALUES ($1, 'c1', $2)`, accountID, chatID); err != nil {
		t.Fatal(err)
	}
	got, _, err := h.svc.GetChat(ctx, owner, chatID)
	if err != nil {
		t.Fatal(err)
	}
	if got.GetExternalSource() != "telegram" || got.GetMyPermissions()&(permSend|permMedia) != 0 {
		t.Fatalf("a linked chat shows source %q and permissions %b: it must name its app and carry no right to send",
			got.GetExternalSource(), got.GetMyPermissions())
	}
	_, err = h.svc.SendMessage(ctx, owner, &appv1.SendMessageRequest{ChatId: chatID, Text: "hello"})
	if codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("send into a linked chat = %v, want PermissionDenied", err)
	}
	// The import itself still writes.
	if err := h.importInto(chatID, owner, func(it *ImportTx) error {
		_, err := it.Append(ctx, []ImportMessage{{FromID: owner, Date: time.Now(), Text: "from the other app"}})
		return err
	}); err != nil {
		t.Fatalf("import into a linked chat: %v", err)
	}
}

func TestErasingTheOwnerRemovesImportedData(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	pup := h.puppet(chatID, "lan")
	var accountID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-9', '\x0102') RETURNING id`, owner).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.st.Pool().Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO external_chats (account_id, external_chat_id, chat_id) VALUES ($1, 'c1', $2)`, accountID, chatID)
	exec(`INSERT INTO external_users (account_id, external_user_id, user_id) VALUES ($1, 'u1', $2)`, accountID, pup)
	exec(`INSERT INTO external_messages (account_id, external_chat_id, external_msg_id, chat_id, seq) VALUES ($1, 'c1', 'm1', $2, 1)`, accountID, chatID)
	exec(`INSERT INTO external_tombstones (account_id, external_chat_id, external_msg_id) VALUES ($1, 'c1', 'm2')`, accountID)

	// The erasure leaves the chats first; the puppet never inherits the group.
	if err := h.svc.LeaveAllChats(ctx, owner); err != nil {
		t.Fatal(err)
	}
	var chatGone bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM chats WHERE id = $1`, chatID).Scan(&chatGone); err != nil {
		t.Fatal(err)
	}
	if !chatGone {
		t.Fatal("the imported group still exists after its owner left: a puppet must not inherit it")
	}
	exec(`UPDATE users SET deleted_at = now() WHERE id = $1`, owner)

	for _, table := range []string{"external_accounts", "external_chats", "external_users", "external_messages", "external_tombstones"} {
		var n int
		if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s keeps %d rows after the owner was erased", table, n)
		}
	}
	var name, username string
	var puppetGone bool
	if err := h.st.Pool().QueryRow(ctx, `SELECT name, username, deleted_at IS NOT NULL FROM users WHERE id = $1`, pup).Scan(&name, &username, &puppetGone); err != nil {
		t.Fatal(err)
	}
	if name != "" || !puppetGone || username == "ext_lan" {
		t.Fatalf("puppet keeps name %q username %q gone=%v", name, username, puppetGone)
	}
	var queued int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM external_logouts WHERE owner_id = $1 AND source = 'telegram'`, owner).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("%d logouts queued, want 1", queued)
	}
}

func TestAPrivateCopyCanBeEnabledAgainAfterItWasRemoved(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	other := h.group(owner)
	pup := h.puppet(other, "bot")
	var accountID int64
	if err := h.st.Pool().QueryRow(ctx, `
		INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, 'telegram', 'tg-again', '\\x00') RETURNING id`, owner).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	enable := func() (int64, error) {
		return h.svc.CreateImportedChat(ctx, owner, ImportedChat{Kind: "private", Peer: pup}, func(tx pgx.Tx, chatID int64) error {
			_, err := tx.Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id) VALUES ($1, 'user:1', $2)`, accountID, chatID)
			return err
		})
	}
	first, err := enable()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.DeleteImportedChat(ctx, owner, first); err != nil {
		t.Fatal(err)
	}
	second, err := enable()
	if err != nil {
		t.Fatalf("enabling the same conversation again after removing it = %v, want a new chat", err)
	}
	if second == first {
		t.Fatalf("the new copy reuses the removed chat %d", first)
	}
	// Two live chats of the same two people never exist at once.
	if _, err := enable(); err == nil {
		t.Fatal("a second live private chat of the same pair was created")
	}
}
