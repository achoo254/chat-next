package botadmin_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/botadmin"
	"app.local/server/internal/bottest"
	"connectrpc.com/connect"
)

var assistantSpec = botadmin.SystemBot{
	Username: "helper_bot", Name: "Helper", Description: "Hi", About: "About",
	Commands: []botadmin.CommandSet{{Scope: botadmin.ScopeDefault, Commands: []botadmin.Command{{Command: "start", Description: "Start"}}}},
}

func TestSystemBotIsNobodysBot(t *testing.T) {
	env := bottest.New(t)
	ctx := context.Background()
	sys, err := env.Admin.EnsureSystemBot(ctx, assistantSpec)
	if err != nil {
		t.Fatal(err)
	}
	if !sys.System || sys.OwnerID != sys.ID || sys.Tier() != botadmin.TierInternal || len(sys.Commands) != 1 {
		t.Fatalf("assistant = %+v", sys)
	}
	// No token: nobody calls the Bot API as the assistant.
	if _, err := env.Admin.Authenticate(ctx, fmt.Sprintf("%d:%s", sys.ID, strings.Repeat("a", 40))); !errors.Is(err, botadmin.ErrBadToken) {
		t.Fatalf("authenticate: %v", err)
	}
	// Not managed through the Console, even by itself.
	name := "Changed"
	if _, err := env.Admin.UpdateBot(ctx, sys.ID, &appv1.UpdateBotRequest{BotId: sys.ID, Name: &name}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("update: %v", err)
	}
	if err := env.Admin.DeleteBot(ctx, sys.ID, time.Now(), sys.ID); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("delete: %v", err)
	}
	// A user still creates their full allowance of bots.
	owner := env.User("owner")
	for i := range botadmin.BotsPerOwnerMax {
		if _, err := env.Admin.CreateBot(ctx, owner, fmt.Sprintf("b%02d_bot", i), "B"); err != nil {
			t.Fatalf("bot %d: %v", i, err)
		}
	}
	mine, err := env.Admin.ListMyBots(ctx, owner)
	if err != nil || len(mine) != botadmin.BotsPerOwnerMax {
		t.Fatalf("owner's bots = %d, %v", len(mine), err)
	}
	// Starting again keeps the account and applies the new profile.
	renamed := assistantSpec
	renamed.Name = "Helper 2"
	again, err := env.Admin.EnsureSystemBot(ctx, renamed)
	if err != nil || again.ID != sys.ID || again.Name != "Helper 2" {
		t.Fatalf("ensure again = %+v, %v", again, err)
	}
}

func TestSystemBotUsernameHeldByAUser(t *testing.T) {
	env := bottest.New(t)
	env.User("helper_bot")
	if _, err := env.Admin.EnsureSystemBot(context.Background(), assistantSpec); !errors.Is(err, botadmin.ErrSystemUsernameTaken) {
		t.Fatalf("ensure = %v", err)
	}
}
