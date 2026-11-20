package engine

import (
	"fmt"
	"testing"
)

func TestTheLooksReadABudgetOfConversationsAtATimeAndReachThemAllInTurn(t *testing.T) {
	old := pollBudget
	pollBudget = 4
	defer func() { pollBudget = old }()
	r := &runner{links: map[string]*chatLink{}, turn: map[string]int{}}
	for i := 0; i < 10; i++ {
		r.links[fmt.Sprintf("c%02d", i)] = &chatLink{BackfillDone: true}
	}
	r.links["importing"] = &chatLink{} // not imported yet: not read
	seen := map[string]int{}
	for look := 0; look < 5; look++ { // 5 looks of 4 = 20 reads of 10 chats
		got := r.inTurn("info")
		if len(got) != 4 {
			t.Fatalf("look %d read %d conversations, want the budget of 4", look, len(got))
		}
		for _, c := range got {
			seen[c]++
		}
	}
	if len(seen) != 10 || seen["importing"] != 0 {
		t.Fatalf("read %v, want each of the 10 imported chats twice", seen)
	}
	for c, n := range seen {
		if n != 2 {
			t.Fatalf("%s read %d times in 5 looks, want 2", c, n)
		}
	}
	// a feature has its own turn
	if got := r.inTurn("members"); got[0] != "c00" {
		t.Fatalf("members starts at %s, want c00", got[0])
	}
}
