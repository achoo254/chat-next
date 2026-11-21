package bridge

import (
	"context"
	"testing"
)

func TestLoginOwnerTravelsInTheContext(t *testing.T) {
	if _, ok := LoginOwner(context.Background()); ok {
		t.Fatal("an owner without WithLoginOwner")
	}
	owner, ok := LoginOwner(WithLoginOwner(context.Background(), 42))
	if !ok || owner != 42 {
		t.Fatalf("owner = %d, %v", owner, ok)
	}
}
