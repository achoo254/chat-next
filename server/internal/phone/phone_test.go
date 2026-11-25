package phone

import "testing"

func TestNormalizePhoneWritesEveryFormOfOneNumberTheSameWay(t *testing.T) {
	const want = "+84912345678"
	for _, raw := range []string{"+84912345678", "84912345678", "0912345678", "0912 345 678", "091-234-5678", "(091) 234.5678", "0084912345678", " +84 912 345 678 "} {
		got, ok := Normalize(raw)
		if !ok || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	// Other countries keep their code; Telegram gives numbers without "+".
	for raw, want := range map[string]string{"14155552671": "+14155552671", "+44 20 7946 0958": "+442079460958", "84241234567": "+84241234567"} {
		if got, ok := Normalize(raw); !ok || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
}

func TestNormalizePhoneRefusesWhatIsNotPlainlyANumber(t *testing.T) {
	for _, raw := range []string{"", "   ", "+", "0", "12345", "091234567x", "0912345678 ext 1", "+84 912*345", "84+912345678",
		"+840912345678", "8412345678901", "841234567", "1234567890123456", "+0912345678", "091234567890"} {
		if got, ok := Normalize(raw); ok {
			t.Errorf("Normalize(%q) = %q, want refused", raw, got)
		}
	}
}
