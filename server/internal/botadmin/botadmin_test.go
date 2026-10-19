package botadmin_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/bottest"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

func codeOf(err error) connect.Code {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Code()
	}
	return connect.CodeUnknown
}

func TestCreateBotRules(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	env.User("takenbot") // a human account already holds this username

	for _, name := range []string{"bot", "abbot!", "helper", "x_bo", strings.Repeat("a", 30) + "bot"} {
		if _, err := env.Admin.CreateBot(ctx, owner, name, "X"); codeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("CreateBot(%q) = %v", name, err)
		}
	}
	if _, err := env.Admin.CreateBot(ctx, owner, "TakenBot", "X"); codeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("username of a user: %v", err)
	}
	bot, err := env.Admin.CreateBot(ctx, owner, " Weather_BOT ", "Thời tiết")
	if err != nil {
		t.Fatal(err)
	}
	if bot.GetUser().GetUsername() != "weather_bot" || !bot.GetUser().GetIsBot() || bot.GetHasToken() || !bot.GetPrivacy() ||
		bot.GetTier() != appv1.BotTier_BOT_TIER_NEW {
		t.Fatalf("bot = %v", bot)
	}
	if _, err := env.Admin.CreateBot(ctx, owner, "weather_bot", "Again"); codeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("duplicate bot username: %v", err)
	}
	// Bots are users of the tenant: resolvable by username, with is_bot.
	u, err := env.Chat.ResolveUsername(ctx, owner, "weather_bot")
	if err != nil || !u.GetIsBot() || u.GetId() != bot.GetUser().GetId() {
		t.Fatalf("resolve = %v, %v", u, err)
	}
	// A bot has no token until one is issued.
	if _, err := env.Admin.Authenticate(ctx, fmt.Sprintf("%d:%s", bot.GetUser().GetId(), strings.Repeat("a", 40))); !errors.Is(err, botadmin.ErrBadToken) {
		t.Fatalf("authenticate without token: %v", err)
	}
	// Bots cannot own bots.
	if _, err := env.Admin.CreateBot(ctx, bot.GetUser().GetId(), "childbot", "X"); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("bot creating a bot: %v", err)
	}
}

func TestBotsPerOwnerLimit(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	for i := range botadmin.BotsPerOwnerMax {
		if _, err := env.Admin.CreateBot(ctx, owner, fmt.Sprintf("many%02dbot", i), "X"); err != nil {
			t.Fatal(err)
		}
	}
	_, err := env.Admin.CreateBot(ctx, owner, "onemorebot", "X")
	if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "bots_limit") {
		t.Fatalf("over the limit: %v", err)
	}
	// Deleting frees a slot, but creations are rate limited too: create and
	// delete cannot churn bots without end.
	bots, err := env.Admin.ListMyBots(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.Admin.DeleteBot(ctx, owner, time.Now(), bots[0].GetUser().GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Admin.CreateBot(ctx, owner, "onemorebot", "X"); codeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("creation over the rate limit: %v", err)
	}
}

func TestDeletedBotIsGone(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	botID, _ := env.Bot(owner, "gonebot")
	user := env.User("user")
	if _, err := env.Chat.StartBot(ctx, user, &appv1.StartBotRequest{BotId: botID}); err != nil {
		t.Fatal(err)
	}
	private, _, err := env.Chat.CreatePrivate(ctx, user, botID)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.Admin.DeleteBot(ctx, owner, time.Now(), botID); err != nil {
		t.Fatal(err)
	}
	// Not resolvable nor searchable; the username is free again.
	if _, err := env.Chat.ResolveUsername(ctx, user, "gonebot"); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("resolve a deleted bot: %v", err)
	}
	found, err := env.Chat.SearchUsers(ctx, user, "Bot gonebot", 20)
	if err != nil || len(found) != 0 {
		t.Fatalf("search finds the deleted bot: %v, %v", found, err)
	}
	var renamed string
	if err := env.Store.Pool().QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, botID).Scan(&renamed); err != nil ||
		renamed != fmt.Sprintf("deleted_%d", botID) {
		t.Fatalf("username after delete = %q, %v", renamed, err)
	}
	again, err := env.Admin.CreateBot(ctx, owner, "gonebot", "Again")
	if err != nil || again.GetUser().GetId() == botID {
		t.Fatalf("reuse of a released username = %v, %v", again, err)
	}
	// Writing to it in the existing chat is refused; no new chat opens.
	_, err = env.Chat.SendMessage(ctx, user, &appv1.SendMessageRequest{ChatId: private.GetId(), Text: "hello?"})
	if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "bot_deleted") {
		t.Fatalf("message to a deleted bot: %v", err)
	}
	stranger := env.User("stranger")
	if _, _, err := env.Chat.CreatePrivate(ctx, stranger, botID); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("new chat with a deleted bot: %v", err)
	}
	if _, err := env.Chat.StartBot(ctx, stranger, &appv1.StartBotRequest{BotId: botID}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("start a deleted bot: %v", err)
	}
}

func TestTokenNeedsRecentSignIn(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	botID, token := env.Bot(owner, "secretbot")
	stale := time.Now().Add(-botadmin.RecentSignIn - time.Minute)
	for _, authTime := range []time.Time{{}, stale} {
		_, _, err := env.Admin.ResetBotToken(ctx, owner, authTime, botID)
		if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "reauth_required") {
			t.Fatalf("reset with sign-in at %v: %v", authTime, err)
		}
		err = env.Admin.DeleteBot(ctx, owner, authTime, botID)
		if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "reauth_required") {
			t.Fatalf("delete with sign-in at %v: %v", authTime, err)
		}
		_, err = env.Admin.OwnedRecent(ctx, owner, authTime, botID)
		if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "reauth_required") {
			t.Fatalf("webhook change with sign-in at %v: %v", authTime, err)
		}
	}
	if b, err := env.Admin.OwnedRecent(ctx, owner, time.Now(), botID); err != nil || b.ID != botID {
		t.Fatalf("webhook change after a recent sign-in: %v, %v", b, err)
	}
	if _, err := env.Admin.OwnedRecent(ctx, env.User("intruder"), time.Now(), botID); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("webhook change by another user: %v", err)
	}
	if _, err := env.Admin.Authenticate(ctx, token); err != nil {
		t.Fatalf("token after refused reset: %v", err)
	}
	// Someone else's bot does not exist for the caller.
	other := env.User("other")
	if _, _, err := env.Admin.ResetBotToken(ctx, other, time.Now(), botID); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("reset by another user: %v", err)
	}
	bot, fresh, err := env.Admin.ResetBotToken(ctx, owner, time.Now(), botID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(fresh, fmt.Sprint(botID)+":") || len(fresh) < len(fmt.Sprint(botID))+36 || !bot.GetHasToken() {
		t.Fatalf("token %q, bot %v", fresh, bot)
	}
	if _, err := env.Admin.Authenticate(ctx, token); !errors.Is(err, botadmin.ErrBadToken) {
		t.Fatalf("old token still works: %v", err)
	}
	var stored []byte
	if err := env.Store.Pool().QueryRow(ctx, `SELECT token_hash FROM bots WHERE user_id = $1`, botID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), fresh[strings.Index(fresh, ":")+1:]) {
		t.Fatal("the secret is stored in clear")
	}
	if err := env.Admin.DeleteBot(ctx, owner, time.Now(), botID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Admin.Authenticate(ctx, fresh); !errors.Is(err, botadmin.ErrBadToken) {
		t.Fatalf("deleted bot authenticates: %v", err)
	}
	if bots, err := env.Admin.ListMyBots(ctx, owner); err != nil || len(bots) != 0 {
		t.Fatalf("bots after delete = %v, %v", bots, err)
	}
}

func TestUpdateBot(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	botID, _ := env.Bot(owner, "editbot")
	name, desc, about, privacy := "Trợ lý", "Tôi giúp bạn\nmọi việc", "Bot hỗ trợ", false
	bot, err := env.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{
		BotId: botID, Name: &name, Description: &desc, About: &about, Privacy: &privacy,
		Commands: &appv1.BotCommandSets{Sets: []*appv1.BotCommandSet{
			{Scope: appv1.BotCommandScope_BOT_COMMAND_SCOPE_DEFAULT, Commands: []*appv1.BotCommand{{Command: "start", Description: "Bắt đầu"}}},
			{Scope: appv1.BotCommandScope_BOT_COMMAND_SCOPE_GROUP_ADMIN, Commands: []*appv1.BotCommand{{Command: "ban", Description: "Cấm"}}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bot.GetUser().GetName() != name || bot.GetDescription() != desc || bot.GetAbout() != about || bot.GetPrivacy() ||
		len(bot.GetCommands()) != 2 {
		t.Fatalf("bot = %v", bot)
	}
	admin, err := env.Admin.Info(ctx, owner, botID, botadmin.RoleGroupAdmin)
	if err != nil || len(admin.GetCommands()) != 1 || admin.GetCommands()[0].GetCommand() != "ban" || !admin.GetIsOwner() {
		t.Fatalf("admin menu = %v, %v", admin, err)
	}
	member, err := env.Admin.Info(ctx, owner+1, botID, botadmin.RoleGroupMember)
	if err != nil || len(member.GetCommands()) != 1 || member.GetCommands()[0].GetCommand() != "start" || member.GetIsOwner() {
		t.Fatalf("member menu = %v, %v", member, err)
	}
	long := strings.Repeat("x", 513)
	if _, err := env.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{BotId: botID, Description: &long}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("long description: %v", err)
	}
	dup := &appv1.BotCommandSets{Sets: []*appv1.BotCommandSet{{Scope: appv1.BotCommandScope_BOT_COMMAND_SCOPE_PRIVATE, Commands: []*appv1.BotCommand{
		{Command: "a", Description: "x"}, {Command: "A", Description: "y"},
	}}}}
	if _, err := env.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{BotId: botID, Commands: dup}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("duplicate commands: %v", err)
	}
	// Unset fields stay.
	bot, err = env.Admin.UpdateBot(ctx, owner, &appv1.UpdateBotRequest{BotId: botID})
	if err != nil || bot.GetDescription() != desc || len(bot.GetCommands()) != 2 {
		t.Fatalf("empty update = %v, %v", bot, err)
	}
}

func TestRecordUpdateFetchAndNotRunning(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	owner := env.User("owner")
	stranger := env.User("stranger")
	botID, _ := env.Bot(owner, "pollbot")
	clock := time.Now()
	env.Admin.SetClock(func() time.Time { return clock })
	stored := func() time.Duration {
		t.Helper()
		var age float64
		if err := env.Store.Pool().QueryRow(ctx,
			`SELECT extract(epoch FROM now() - last_update_fetch_at) FROM bots WHERE user_id = $1`, botID).Scan(&age); err != nil {
			t.Fatal(err)
		}
		return time.Duration(age * float64(time.Second))
	}
	notRunning := func(caller int64) bool {
		t.Helper()
		info, err := env.Admin.Info(ctx, caller, botID, botadmin.RolePrivate)
		if err != nil {
			t.Fatal(err)
		}
		return info.GetNotRunning()
	}
	backdate := func(by string) {
		t.Helper()
		if _, err := env.Store.Pool().Exec(ctx,
			`UPDATE bots SET last_update_fetch_at = now() - $2::interval WHERE user_id = $1`, botID, by); err != nil {
			t.Fatal(err)
		}
	}

	if !notRunning(owner) {
		t.Fatal("a bot that never polled counts as running")
	}
	if err := env.Admin.RecordUpdateFetch(ctx, botID); err != nil {
		t.Fatal(err)
	}
	if age := stored(); age > 5*time.Second {
		t.Fatalf("first fetch not recorded: %v old", age)
	}
	if notRunning(owner) {
		t.Fatal("a bot that just polled counts as stopped")
	}

	// Within the interval after this process wrote, the database is not asked.
	backdate("5 minutes")
	if err := env.Admin.RecordUpdateFetch(ctx, botID); err != nil {
		t.Fatal(err)
	}
	if age := stored(); age < 4*time.Minute {
		t.Fatalf("a fetch within the interval reached the database (record %v old)", age)
	}
	// The server's clock decides, and only the owner is told.
	if !notRunning(owner) || notRunning(stranger) {
		t.Fatalf("not running: owner %v, stranger %v; want true, false", notRunning(owner), notRunning(stranger))
	}

	// After the interval it writes again.
	clock = clock.Add(31 * time.Second)
	if err := env.Admin.RecordUpdateFetch(ctx, botID); err != nil {
		t.Fatal(err)
	}
	if age := stored(); age > 5*time.Second {
		t.Fatalf("a fetch after the interval did not write (record %v old)", age)
	}
	if notRunning(owner) {
		t.Fatal("a bot that polled 31 seconds of server time ago counts as stopped")
	}
	clock = clock.Add(3 * time.Minute)
	if !notRunning(owner) {
		t.Fatal("a bot silent for 3 minutes counts as running")
	}

	// Another process (no memory of the write) still writes at most once per
	// interval, through the database.
	other, err := botadmin.New(env.Store.Pool(), bottest.TenantID, bottest.MiniAppURLs(t), env.Limiter, bottest.Quiet)
	if err != nil {
		t.Fatal(err)
	}
	backdate("10 seconds")
	if err := other.RecordUpdateFetch(ctx, botID); err != nil {
		t.Fatal(err)
	}
	if age := stored(); age < 5*time.Second {
		t.Fatalf("a recent record was written again (record %v old)", age)
	}
}

func TestBotTierOrder(t *testing.T) {
	old := time.Now().Add(-30 * 24 * time.Hour)
	now := time.Now()
	cases := []struct {
		bot  botadmin.Bot
		want string
	}{
		{botadmin.Bot{CreatedAt: now}, botadmin.TierNew},
		{botadmin.Bot{CreatedAt: old}, botadmin.TierDefault},
		{botadmin.Bot{CreatedAt: now, Verified: true}, botadmin.TierVerified},
		{botadmin.Bot{CreatedAt: old, Verified: true, RestrictedAt: &now}, botadmin.TierRestricted},
		{botadmin.Bot{CreatedAt: old, Internal: true, RestrictedAt: &now}, botadmin.TierInternal},
	}
	for i, c := range cases {
		if got := c.bot.Tier(); got != c.want {
			t.Errorf("case %d: tier = %s, want %s", i, got, c.want)
		}
	}
}
