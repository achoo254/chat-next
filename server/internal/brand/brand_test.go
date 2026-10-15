package brand

import (
	"os"
	"path/filepath"
	"testing"
)

// The embedded copy must match brand.config.json; run `pnpm brand:gen`
// after editing the brand.
func TestEmbeddedNamesMatchTheBrandConfig(t *testing.T) {
	embedded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "brand.config.json"))
	if err != nil {
		t.Skipf("brand.config.json is not available outside the repository: %v", err)
	}
	want, err := parse(source)
	if err != nil {
		t.Fatal(err)
	}
	if embedded != want {
		t.Fatalf("server/internal/brand/brand.json is %+v, brand.config.json says %+v: run pnpm brand:gen", embedded, want)
	}
}

func TestParseRefusesMissingNames(t *testing.T) {
	for _, body := range []string{`{}`, `{"appName":"A"}`, `{"appName":" ","shortName":"B"}`, `not json`} {
		if _, err := parse([]byte(body)); err == nil {
			t.Errorf("parse(%s) accepted", body)
		}
	}
}
