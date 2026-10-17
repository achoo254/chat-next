// Command sdkgen generates the models and API methods of the bot SDKs
// (TypeScript, Python, Go) from the Bot API's OpenAPI document; the
// transport, long poll, webhook handler and router are written by hand in
// each SDK.
//
//	go run ./cmd/sdkgen          (from server/) rewrites the generated files
//	go run ./cmd/sdkgen -check   fails when one is out of date
//
// The package's test runs the check, so `go test ./...` fails when the spec
// changes and the SDKs were not regenerated.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// root is the repository root: go run works from server/, go test from
// this package's directory.
func root() (string, error) {
	for _, dir := range []string{"..", "../../.."} {
		if _, err := os.Stat(filepath.Join(dir, "spec/bot-api/openapi.yaml")); err == nil {
			return dir, nil
		}
	}
	return "", fmt.Errorf("run from server/ or server/cmd/sdkgen")
}

// outputs maps each generated file (relative to the root) to its content.
func outputs(dir string) (map[string][]byte, error) {
	s, err := loadSpec(filepath.Join(dir, "spec/bot-api/openapi.yaml"))
	if err != nil {
		return nil, err
	}
	return map[string][]byte{
		"sdk/ts/src/generated.ts":          []byte(typescript(s)),
		"sdk/python/chatbot/_generated.py": []byte(python(s)),
		"sdk/go/generated.go":              goSource(s),
	}, nil
}

// stale lists the generated files that differ from what the spec gives.
func stale(dir string) ([]string, error) {
	files, err := outputs(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(got, want) {
			out = append(out, name)
		}
	}
	return out, nil
}

func main() {
	check := flag.Bool("check", false, "fail when a generated file is out of date instead of writing it")
	flag.Parse()
	dir, err := root()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sdkgen:", err)
		os.Exit(2)
	}
	if *check {
		names, err := stale(dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "sdkgen:", err)
			os.Exit(2)
		}
		if len(names) > 0 {
			fmt.Fprintf(os.Stderr, "sdkgen: out of date (run go run ./cmd/sdkgen in server/): %v\n", names)
			os.Exit(1)
		}
		return
	}
	files, err := outputs(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sdkgen:", err)
		os.Exit(2)
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "sdkgen:", err)
			os.Exit(2)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "sdkgen:", err)
			os.Exit(2)
		}
	}
}
