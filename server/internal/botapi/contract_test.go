package botapi

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
)

// The contract check (Phase 8: every Bot API response matches
// spec/bot-api/openapi.yaml): every response the tests of this package get
// through the harness, success or error, is validated against the schema
// the spec gives for its operation and status; a status the spec does not
// list for the operation fails. A full run (no -run filter) also fails
// unless every operation answered 2xx at least once and GET /updates
// returned every update kind, so a method or kind added to the server
// without a test, or to the spec without a server, is caught.

const specPath = "../../../spec/bot-api/openapi.yaml"

type contractOp struct {
	id      string
	method  string
	pattern *regexp.Regexp
	// schemas by status ("200", "404", …): compiled response schema.
	schemas map[string]*jsonschema.Schema
}

type contractSpec struct {
	ops      []*contractOp
	envelope *jsonschema.Schema
	kinds    []string

	mu       sync.Mutex
	answered map[string]bool
	kindSeen map[string]bool
}

var (
	contractOnce sync.Once
	contract     *contractSpec
	contractErr  error
)

func loadContract() (*contractSpec, error) {
	contractOnce.Do(func() { contract, contractErr = parseContract() })
	return contract, contractErr
}

func parseContract() (*contractSpec, error) {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse spec: %w", err)
	}
	components, _ := doc["components"].(map[string]any)
	responses, _ := components["responses"].(map[string]any)
	// Response schemas are copied under x-contract (simple pointers); their
	// $refs to #/components/... still resolve in the same document.
	extracted := map[string]any{}
	type pending struct {
		op     *contractOp
		status string
		key    string
	}
	var todo []pending
	spec := &contractSpec{answered: map[string]bool{}, kindSeen: map[string]bool{}}
	paths, _ := doc["paths"].(map[string]any)
	templates := make([]string, 0, len(paths))
	for p := range paths {
		templates = append(templates, p)
	}
	sort.Strings(templates)
	for _, tmpl := range templates {
		item, _ := paths[tmpl].(map[string]any)
		pattern := regexp.MustCompile("^/bot/v1" + regexp.MustCompile(`\\\{[a-z_]+\\\}`).
			ReplaceAllString(regexp.QuoteMeta(tmpl), `[^/:]+`) + "$")
		for _, method := range []string{"get", "put", "post", "patch", "delete"} {
			op, ok := item[method].(map[string]any)
			if !ok {
				continue
			}
			co := &contractOp{id: fmt.Sprint(op["operationId"]), method: strings.ToUpper(method), pattern: pattern,
				schemas: map[string]*jsonschema.Schema{}}
			spec.ops = append(spec.ops, co)
			list, _ := op["responses"].(map[string]any)
			for status, r := range list {
				resp, _ := r.(map[string]any)
				if ref, ok := resp["$ref"].(string); ok {
					resp, _ = responses[strings.TrimPrefix(ref, "#/components/responses/")].(map[string]any)
				}
				content, _ := resp["content"].(map[string]any)
				media, _ := content["application/json"].(map[string]any)
				schema, ok := media["schema"]
				if !ok {
					return nil, fmt.Errorf("%s %s: no JSON schema", co.id, status)
				}
				key := fmt.Sprintf("s%d", len(todo))
				extracted[key] = schema
				todo = append(todo, pending{co, status, key})
			}
		}
	}
	doc["x-contract"] = extracted
	schemas, _ := components["schemas"].(map[string]any)
	kind, _ := schemas["UpdateKind"].(map[string]any)
	for _, k := range kind["enum"].([]any) {
		spec.kinds = append(spec.kinds, fmt.Sprint(k))
	}
	asJSON, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
	if err != nil {
		return nil, err
	}
	const url = "https://spec.test/openapi.json"
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	if err := c.AddResource(url, value); err != nil {
		return nil, err
	}
	for _, p := range todo {
		sch, err := c.Compile(url + "#/x-contract/" + p.key)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", p.op.id, p.status, err)
		}
		p.op.schemas[p.status] = sch
	}
	if spec.envelope, err = c.Compile(url + "#/components/schemas/ErrorEnvelope"); err != nil {
		return nil, err
	}
	return spec, nil
}

// reporter is the part of testing.TB the check reports to.
type reporter interface {
	Helper()
	Errorf(format string, args ...any)
}

// check validates one response of the Bot API.
func (c *contractSpec) check(t reporter, method, path string, status int, body []byte) {
	t.Helper()
	path, _, _ = strings.Cut(path, "?")
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Errorf("contract: %s %s: body is not JSON: %v", method, path, err)
		return
	}
	var op *contractOp
	pathKnown := false
	for _, o := range c.ops {
		if o.pattern.MatchString(path) {
			pathKnown = true
			if o.method == method {
				op = o
			}
		}
	}
	code := strconv.Itoa(status)
	if op == nil {
		// Unknown method or path: only an error envelope (404, 405) is fine.
		if status < 400 || (pathKnown && status != 405) {
			t.Errorf("contract: %s %s answered %d but the spec has no such operation", method, path, status)
			return
		}
		if err := c.envelope.Validate(value); err != nil {
			t.Errorf("contract: %s %s %d: %v", method, path, status, err)
		}
		return
	}
	sch, ok := op.schemas[code]
	if !ok {
		t.Errorf("contract: %s (%s %s) answered %d, which the spec does not list: %s", op.id, method, path, status, body)
		return
	}
	if err := sch.Validate(value); err != nil {
		t.Errorf("contract: %s (%s %s) %d does not match the spec: %v\nbody: %s", op.id, method, path, status, err, body)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if status/100 == 2 {
		c.answered[op.id] = true
	}
	if op.id == "getUpdates" && status == 200 {
		var env struct {
			Result []map[string]json.RawMessage `json:"result"`
		}
		if json.Unmarshal(body, &env) == nil {
			for _, u := range env.Result {
				for k := range u {
					c.kindSeen[k] = true
				}
			}
		}
	}
}

// missing lists the operations never answered 2xx and the update kinds
// never returned.
func (c *contractSpec) missing() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, op := range c.ops {
		if !c.answered[op.id] && !slices.Contains(out, op.id) {
			out = append(out, "operation "+op.id)
		}
	}
	for _, k := range c.kinds {
		if !c.kindSeen[k] {
			out = append(out, "update kind "+k)
		}
	}
	return out
}

// contractCoverage runs after a full test run of the package and returns
// a non-zero exit code when the spec is not fully covered.
func contractCoverage(code int) int {
	if code != 0 {
		return code
	}
	if run := flag.Lookup("test.run"); run != nil && run.Value.String() != "" {
		return code
	}
	spec, err := loadContract()
	if err != nil {
		fmt.Fprintln(os.Stderr, "contract:", err)
		return 1
	}
	if gaps := spec.missing(); len(gaps) > 0 {
		fmt.Fprintf(os.Stderr, "contract: not covered by any test response: %s\n", strings.Join(gaps, ", "))
		return 1
	}
	return code
}

func TestContractSpecLoads(t *testing.T) {
	spec, err := loadContract()
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.ops) < 20 || len(spec.kinds) < 6 {
		t.Fatalf("spec has %d operations and %d update kinds", len(spec.ops), len(spec.kinds))
	}
	// The validator rejects what the spec forbids.
	spec.mustFail(t, "GET", "/bot/v1/me", 200, `{"ok": true, "result": {"id": 1, "is_bot": true}}`)
	spec.mustFail(t, "GET", "/bot/v1/me", 418, `{"ok": false, "error": {"code": "x", "description": "y"}}`)
	spec.mustFail(t, "GET", "/bot/v1/me", 401, `{"ok": false}`)
}

// probe records whether the check reported a problem.
type probe struct{ failed bool }

func (p *probe) Helper()               {}
func (p *probe) Errorf(string, ...any) { p.failed = true }

// mustFail checks that a response is refused.
func (c *contractSpec) mustFail(t *testing.T, method, path string, status int, body string) {
	t.Helper()
	var p probe
	c.check(&p, method, path, status, []byte(body))
	if !p.failed {
		t.Fatalf("contract accepted %d %s", status, body)
	}
}
