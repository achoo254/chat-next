package main

import (
	"fmt"
	"go/format"
	"strings"
)

// goInitialisms are written in capitals in Go names (ChatID, URL).
var goInitialisms = map[string]string{"id": "ID", "ids": "IDs", "url": "URL", "html": "HTML", "json": "JSON", "api": "API", "http": "HTTP"}

// goSource emits sdk/go/generated.go: the models as structs (a union as
// one struct with every variant's fields) and the API methods on *Client.
func goSource(s *Spec) []byte {
	var b strings.Builder
	b.WriteString(header("//"))
	b.WriteString("package chatbot\n\nimport (\n\t\"context\"\n\t\"net/url\"\n\t\"strconv\"\n)\n\n")
	fmt.Fprintf(&b, "// APIVersion is the version of the Bot API these types and methods follow.\nconst APIVersion = %q\n", s.Version)
	variants := map[*Schema]bool{}
	for _, sc := range s.Schemas {
		for _, v := range sc.OneOf {
			variants[v] = true
		}
	}
	for _, sc := range s.Schemas {
		// Variants merge into their union; ids are plain int64.
		if variants[sc] || (sc.Type == "integer" && len(sc.Enum) == 0) {
			continue
		}
		b.WriteString("\n")
		if sc.Description != "" {
			goDoc(&b, "", sc.Name+": "+sc.Description)
		}
		switch {
		case len(sc.OneOf) > 0:
			fmt.Fprintf(&b, "type %s struct {\n", sc.Name)
			seen := map[string]bool{}
			for _, v := range sc.OneOf {
				props, _ := s.fields(v)
				for _, p := range props {
					if !seen[p.Name] {
						seen[p.Name] = true
						goField(&b, s, p, false)
					}
				}
			}
			b.WriteString("}\n")
		case sc.Type == "object" || len(sc.AllOf) > 0:
			props, required := s.fields(sc)
			fmt.Fprintf(&b, "type %s struct {\n", sc.Name)
			for _, p := range props {
				goField(&b, s, p, required[p.Name])
			}
			b.WriteString("}\n")
		case len(sc.Enum) > 0:
			fmt.Fprintf(&b, "type %s string\n\nconst (\n", sc.Name)
			for _, e := range sc.Enum {
				fmt.Fprintf(&b, "\t%s%s %s = %q\n", sc.Name, goName(e), sc.Name, e)
			}
			b.WriteString(")\n")
		default:
			fmt.Fprintf(&b, "type %s = %s\n", sc.Name, goExpr(s, sc))
		}
	}
	for _, op := range s.Ops {
		q := queryParams(op)
		if len(q) == 0 {
			continue
		}
		name := pascal(op.ID) + "Params"
		fmt.Fprintf(&b, "\n// %s are the query parameters of %s; zero values are left out.\ntype %s struct {\n", name, pascal(op.ID), name)
		for _, p := range q {
			goDoc(&b, "\t", p.Description)
			fmt.Fprintf(&b, "\t%s %s\n", goName(p.Name), goExpr(s, p.Schema))
		}
		fmt.Fprintf(&b, "}\n\nfunc (p %s) values() url.Values {\n\tv := url.Values{}\n", name)
		for _, p := range q {
			field := "p." + goName(p.Name)
			switch goExpr(s, p.Schema) {
			case "int64":
				fmt.Fprintf(&b, "\tif %s != 0 {\n\t\tv.Set(%q, strconv.FormatInt(%s, 10))\n\t}\n", field, p.Name, field)
			case "bool":
				fmt.Fprintf(&b, "\tif %s {\n\t\tv.Set(%q, \"true\")\n\t}\n", field, p.Name)
			default:
				fmt.Fprintf(&b, "\tif %s != \"\" {\n\t\tv.Set(%q, %s)\n\t}\n", field, p.Name, field)
			}
		}
		b.WriteString("\treturn v\n}\n")
	}
	for _, op := range s.Ops {
		b.WriteString("\n")
		goDoc(&b, "", pascal(op.ID)+": "+op.Summary+"\n\n"+op.Description)
		args := []string{"ctx context.Context"}
		path := fmt.Sprintf("%q", op.Path)
		for _, p := range pathParams(op) {
			typ := goExpr(s, p.Schema)
			name := goVar(p.Name)
			args = append(args, name+" "+typ)
			seg := "url.PathEscape(" + name + ")"
			if typ == "int64" {
				seg = "strconv.FormatInt(" + name + ", 10)"
			}
			path = strings.Replace(path, "{"+p.Name+"}", `"+`+seg+`+"`, 1)
		}
		path = strings.TrimSuffix(strings.TrimPrefix(path, `""+`), `+""`)
		query, body := "nil", "nil"
		if op.Body != nil {
			args = append(args, "req "+goExpr(s, op.Body))
			body = "req"
		}
		if len(queryParams(op)) > 0 {
			args = append(args, "params "+pascal(op.ID)+"Params")
			query = "params.values()"
		}
		sig := fmt.Sprintf("func (c *Client) %s(%s)", pascal(op.ID), strings.Join(args, ", "))
		call := fmt.Sprintf("c.call(ctx, %q, %s, %s, %s", op.Method, path, query, body)
		switch {
		case isTrue(op.Result):
			fmt.Fprintf(&b, "%s error {\n\treturn %s, nil)\n}\n", sig, call)
		case op.Result.Type == "array":
			typ := goExpr(s, op.Result)
			fmt.Fprintf(&b, "%s (%s, error) {\n\tvar out %s\n\tif err := %s, &out); err != nil {\n\t\treturn nil, err\n\t}\n\treturn out, nil\n}\n", sig, typ, typ, call)
		default:
			typ := goExpr(s, op.Result)
			fmt.Fprintf(&b, "%s (*%s, error) {\n\tvar out %s\n\tif err := %s, &out); err != nil {\n\t\treturn nil, err\n\t}\n\treturn &out, nil\n}\n", sig, typ, typ, call)
		}
	}
	src, err := format.Source([]byte(b.String()))
	if err != nil {
		panic(fmt.Sprintf("sdkgen: generated Go does not parse: %v", err))
	}
	return src
}

func goField(b *strings.Builder, s *Spec, p Prop, required bool) {
	goDoc(b, "\t", p.Description)
	typ := goExpr(s, p.Schema)
	tag := p.Name
	target := s.resolve(p.Schema)
	isStruct := (target.Type == "object" || len(target.AllOf) > 0 || len(target.OneOf) > 0) && !strings.HasPrefix(typ, "map[")
	switch {
	case p.Schema.Binary:
		typ, tag = "*InputFile", "-"
	case !required && isStruct:
		typ, tag = "*"+typ, tag+",omitempty"
	case !required:
		tag += ",omitempty"
	}
	fmt.Fprintf(b, "\t%s %s `json:%q`\n", goName(p.Name), typ, tag)
}

func goExpr(s *Spec, sc *Schema) string {
	switch {
	case sc.Ref != "":
		name := refName(sc.Ref)
		if t := s.byName[name]; t.Type == "integer" && len(t.Enum) == 0 {
			return "int64"
		}
		return name
	case sc.Name != "":
		return sc.Name
	case sc.Const != nil:
		if sc.Const.Tag == "!!str" {
			return "string"
		}
		return "bool"
	}
	switch sc.Type {
	case "array":
		return "[]" + goExpr(s, sc.Items)
	case "integer":
		return "int64"
	case "number":
		return "float64"
	case "string":
		return "string"
	case "boolean":
		return "bool"
	case "object":
		return "map[string]any"
	}
	return "any"
}

// goName turns a wire name (snake_case, camelCase or a value like "html")
// into an exported Go name with Go's initialisms.
func goName(s string) string {
	var b strings.Builder
	for _, part := range strings.Split(snake(s), "_") {
		if part == "" {
			continue
		}
		if up, ok := goInitialisms[part]; ok {
			b.WriteString(up)
			continue
		}
		b.WriteString(pascal(part))
	}
	return b.String()
}

// goVar is goName for an unexported identifier: the first word in lower
// case (chat_id: chatID).
func goVar(s string) string {
	first, rest, _ := strings.Cut(snake(s), "_")
	return first + goName(rest)
}

func goDoc(b *strings.Builder, indent, text string) {
	for _, l := range wrap(text, 96) {
		fmt.Fprintf(b, "%s%s\n", indent, strings.TrimRight("// "+l, " "))
	}
}
