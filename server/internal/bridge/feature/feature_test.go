package feature

import "testing"

func TestEveryFeatureHasARiskAndADefault(t *testing.T) {
	for _, f := range All() {
		if !Valid(f) {
			t.Errorf("%s is listed but not valid", f)
		}
		if RiskOf(f) == 0 {
			t.Errorf("%s has no risk", f)
		}
		for _, m := range []Direction{In, Both} {
			if d := Default(f, m); !d.Valid() {
				t.Errorf("default of %s for %s messages is %q", f, m, d)
			}
		}
	}
	if Valid("nope") {
		t.Error("an unknown feature is valid")
	}
}

func TestDefaultsFollowTheMessagesExceptForPeopleAndTyping(t *testing.T) {
	for _, tc := range []struct {
		f        Feature
		messages Direction
		want     Direction
	}{
		{Messages, In, In}, {Messages, Both, Both},
		{Pins, In, In}, {Pins, Both, Both},
		{Reactions, Both, Both}, {Read, In, In}, {Notify, Both, Both}, {Dialog, Both, Both},
		{Topics, Both, Both}, {Info, In, In},
		{Members, Both, Off}, {Invites, Both, Off}, {Typing, Both, Off}, {Lifecycle, Both, Off}, {Alerts, Both, Off}, {Alerts, In, Off},
	} {
		if got := Default(tc.f, tc.messages); got != tc.want {
			t.Errorf("Default(%s, %s) = %s, want %s", tc.f, tc.messages, got, tc.want)
		}
	}
}

func TestADirectionSaysWhichWayThingsFlow(t *testing.T) {
	for _, tc := range []struct {
		d               Direction
		receives, sends bool
	}{{Off, false, false}, {In, true, false}, {Out, false, true}, {Both, true, true}} {
		if tc.d.Receives() != tc.receives || tc.d.Sends() != tc.sends {
			t.Errorf("%s: receives=%v sends=%v", tc.d, tc.d.Receives(), tc.d.Sends())
		}
	}
}

func TestSupportAllowsOnlyWhatTheAdapterHas(t *testing.T) {
	readOnly := Support{In: true}
	if !readOnly.Allows(Off) || !readOnly.Allows(In) || readOnly.Allows(Out) || readOnly.Allows(Both) {
		t.Error("an adapter that only reads allows more than reading")
	}
	if !(Support{In: true, Out: true}).Allows(Both) || (Support{Out: true}).Allows(Both) {
		t.Error("both ways needs both flows")
	}
}
