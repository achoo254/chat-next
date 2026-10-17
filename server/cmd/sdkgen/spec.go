package main

import (
	"fmt"
	"os"
	"strings"
	"unicode"

	"go.yaml.in/yaml/v3"
)

// Schema is the part of a JSON Schema the Bot API spec uses. Property order
// is kept from the spec so the generated code reads like it.
type Schema struct {
	// Name is set for component schemas and for inline objects and union
	// variants the generator names after their parent.
	Name        string
	Ref         string
	Type        string
	Title       string
	Description string
	Props       []Prop
	Required    map[string]bool
	Items       *Schema
	Enum        []string
	// Const is a scalar the field always holds ("sendMessage", true).
	Const *yaml.Node
	AllOf []*Schema
	OneOf []*Schema
	// Binary: a file part of a multipart form (contentMediaType).
	Binary bool
}

// Prop is an object property.
type Prop struct {
	Name        string
	Schema      *Schema
	Description string
}

// Param is a path or query parameter of an operation.
type Param struct {
	Name        string
	In          string
	Required    bool
	Schema      *Schema
	Description string
}

// Operation is one Bot API method.
type Operation struct {
	ID          string
	Method      string
	Path        string
	Summary     string
	Description string
	Params      []Param
	// Body is the JSON request body schema, nil without one.
	Body *Schema
	// Result is the `result` of the 200 answer's envelope.
	Result *Schema
}

// Spec is the parsed OpenAPI document.
type Spec struct {
	Version string
	// Schemas lists every named type in emission order: component schemas,
	// each followed by the inline types named after it.
	Schemas []*Schema
	byName  map[string]*Schema
	Ops     []*Operation
}

func loadSpec(path string) (*Spec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	root := doc.Content[0]
	s := &Spec{byName: map[string]*Schema{}, Version: scalar(get(get(root, "info"), "version"))}
	components := get(root, "components")
	responses := get(components, "responses")
	schemas := get(components, "schemas")
	for i := 0; i+1 < len(schemas.Content); i += 2 {
		name := schemas.Content[i].Value
		sc := parseSchema(schemas.Content[i+1])
		sc.Name = name
		s.add(sc)
	}
	paths := get(root, "paths")
	for i := 0; i+1 < len(paths.Content); i += 2 {
		path, item := paths.Content[i].Value, paths.Content[i+1]
		shared := parseParams(get(item, "parameters"))
		for j := 0; j+1 < len(item.Content); j += 2 {
			method := item.Content[j].Value
			if method == "parameters" {
				continue
			}
			op, err := parseOperation(strings.ToUpper(method), path, item.Content[j+1], shared, responses)
			if err != nil {
				return nil, err
			}
			s.Ops = append(s.Ops, op)
		}
	}
	return s, nil
}

// add records a named schema, then names its inline objects and union
// variants after it so every object type has a name.
func (s *Spec) add(sc *Schema) {
	s.Schemas = append(s.Schemas, sc)
	s.byName[sc.Name] = sc
	for i, v := range sc.OneOf {
		if v.Ref != "" {
			continue
		}
		v.Name = v.Title
		if v.Name == "" {
			v.Name = fmt.Sprintf("%s%d", sc.Name, i+1)
		}
		s.add(v)
	}
	for _, p := range sc.Props {
		s.nameInline(p.Schema, sc.Name+pascal(p.Name))
	}
}

func (s *Spec) nameInline(sc *Schema, name string) {
	switch {
	case sc.Ref != "":
	case sc.Type == "object" && len(sc.Props) > 0:
		sc.Name = name
		s.add(sc)
	case sc.Type == "array" && sc.Items != nil:
		s.nameInline(sc.Items, name+"Item")
	}
}

// resolve follows a $ref to its component schema.
func (s *Spec) resolve(sc *Schema) *Schema {
	for sc.Ref != "" {
		sc = s.byName[refName(sc.Ref)]
	}
	return sc
}

// fields are an object's properties, allOf parts merged in order.
func (s *Spec) fields(sc *Schema) ([]Prop, map[string]bool) {
	sc = s.resolve(sc)
	if len(sc.AllOf) == 0 {
		return sc.Props, sc.Required
	}
	var props []Prop
	required := map[string]bool{}
	for _, part := range sc.AllOf {
		p, r := s.fields(part)
		props = append(props, p...)
		for k := range r {
			required[k] = true
		}
	}
	return props, required
}

func parseOperation(method, path string, n *yaml.Node, shared []Param, responses *yaml.Node) (*Operation, error) {
	op := &Operation{
		ID: scalar(get(n, "operationId")), Method: method, Path: path,
		Summary: scalar(get(n, "summary")), Description: scalar(get(n, "description")),
		Params: append(append([]Param{}, shared...), parseParams(get(n, "parameters"))...),
	}
	if body := get(get(get(get(n, "requestBody"), "content"), "application/json"), "schema"); body != nil {
		op.Body = parseSchema(body)
	}
	ok := get(get(n, "responses"), "200")
	if ref := scalar(get(ok, "$ref")); ref != "" {
		ok = get(responses, refName(ref))
	}
	result := get(get(get(get(get(ok, "content"), "application/json"), "schema"), "properties"), "result")
	if result == nil {
		return nil, fmt.Errorf("%s: no result in the 200 answer", op.ID)
	}
	op.Result = parseSchema(result)
	return op, nil
}

func parseParams(n *yaml.Node) []Param {
	if n == nil {
		return nil
	}
	var out []Param
	for _, p := range n.Content {
		out = append(out, Param{
			Name: scalar(get(p, "name")), In: scalar(get(p, "in")), Required: scalar(get(p, "required")) == "true",
			Schema: parseSchema(get(p, "schema")), Description: scalar(get(p, "description")),
		})
	}
	return out
}

func parseSchema(n *yaml.Node) *Schema {
	sc := &Schema{
		Ref: scalar(get(n, "$ref")), Type: scalar(get(n, "type")), Title: scalar(get(n, "title")),
		Description: scalar(get(n, "description")), Const: get(n, "const"), Required: map[string]bool{},
		Binary: get(n, "contentMediaType") != nil,
	}
	if props := get(n, "properties"); props != nil {
		for i := 0; i+1 < len(props.Content); i += 2 {
			child := props.Content[i+1]
			sc.Props = append(sc.Props, Prop{Name: props.Content[i].Value, Schema: parseSchema(child), Description: scalar(get(child, "description"))})
		}
		if sc.Type == "" {
			sc.Type = "object"
		}
	}
	if req := get(n, "required"); req != nil {
		for _, r := range req.Content {
			sc.Required[r.Value] = true
		}
	}
	if items := get(n, "items"); items != nil {
		sc.Items = parseSchema(items)
	}
	if enum := get(n, "enum"); enum != nil {
		for _, e := range enum.Content {
			sc.Enum = append(sc.Enum, e.Value)
		}
	}
	for _, part := range seq(get(n, "allOf")) {
		sc.AllOf = append(sc.AllOf, parseSchema(part))
	}
	for _, part := range seq(get(n, "oneOf")) {
		sc.OneOf = append(sc.OneOf, parseSchema(part))
	}
	return sc
}

// get returns the value of key in a mapping node, nil when absent.
func get(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func scalar(n *yaml.Node) string {
	if n == nil {
		return ""
	}
	return n.Value
}

func seq(n *yaml.Node) []*yaml.Node {
	if n == nil {
		return nil
	}
	return n.Content
}

func refName(ref string) string {
	return ref[strings.LastIndex(ref, "/")+1:]
}

// pascal turns snake_case or camelCase into PascalCase.
func pascal(s string) string {
	var b strings.Builder
	for _, part := range strings.Split(s, "_") {
		if part == "" {
			continue
		}
		r := []rune(part)
		r[0] = unicode.ToUpper(r[0])
		b.WriteString(string(r))
	}
	return b.String()
}

// snake turns camelCase into snake_case.
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('_')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// wrap fills a description into lines of at most width runes, keeping
// paragraphs and list items ("- ") apart.
func wrap(text string, width int) []string {
	var lines []string
	for i, para := range strings.Split(strings.TrimSpace(text), "\n\n") {
		if i > 0 {
			lines = append(lines, "")
		}
		var blocks []string
		for _, l := range strings.Split(para, "\n") {
			if strings.HasPrefix(strings.TrimSpace(l), "- ") || len(blocks) == 0 {
				blocks = append(blocks, l)
			} else {
				blocks[len(blocks)-1] += " " + l
			}
		}
		for _, block := range blocks {
			indent := ""
			if strings.HasPrefix(strings.TrimSpace(block), "- ") {
				indent = "  "
			}
			line := ""
			for _, word := range strings.Fields(block) {
				if line != "" && len([]rune(line))+1+len([]rune(word)) > width {
					lines = append(lines, line)
					line = indent + word
					continue
				}
				if line != "" {
					line += " "
				}
				line += word
			}
			if line != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}
