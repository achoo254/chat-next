package main

import (
	"fmt"
	"strings"
)

// typescript emits sdk/ts/src/generated.ts: the models as interfaces and
// the API methods on an abstract class the hand-written client extends.
func typescript(s *Spec) string {
	var b strings.Builder
	b.WriteString(header("//"))
	b.WriteString("import type { InputFile } from \"./input-file.ts\";\n\n")
	fmt.Fprintf(&b, "/** Version of the Bot API these types and methods follow. */\nexport const API_VERSION = %q;\n", s.Version)
	for _, sc := range s.Schemas {
		b.WriteString("\n")
		tsDoc(&b, "", sc.Description)
		switch {
		case len(sc.OneOf) > 0:
			var parts []string
			for _, v := range sc.OneOf {
				parts = append(parts, tsType(v))
			}
			fmt.Fprintf(&b, "export type %s = %s;\n", sc.Name, strings.Join(parts, " | "))
		case sc.Type == "object" || len(sc.AllOf) > 0:
			props, required := s.fields(sc)
			fmt.Fprintf(&b, "export interface %s {\n", sc.Name)
			for _, p := range props {
				tsDoc(&b, "\t", p.Description)
				opt := "?"
				if required[p.Name] {
					opt = ""
				}
				fmt.Fprintf(&b, "\t%s%s: %s;\n", p.Name, opt, tsType(p.Schema))
			}
			b.WriteString("}\n")
		default:
			fmt.Fprintf(&b, "export type %s = %s;\n", sc.Name, tsExpr(sc))
		}
	}
	for _, op := range s.Ops {
		if q := queryParams(op); len(q) > 0 {
			fmt.Fprintf(&b, "\n/** Query parameters of %s. */\nexport interface %sParams {\n", op.ID, pascal(op.ID))
			for _, p := range q {
				tsDoc(&b, "\t", p.Description)
				fmt.Fprintf(&b, "\t%s?: %s;\n", p.Name, tsType(p.Schema))
			}
			b.WriteString("}\n")
		}
	}
	b.WriteString(`
/** A request of one method: query parameters or a JSON body. */
export interface CallOptions {
	readonly query?: object;
	readonly body?: object;
}

/** Every Bot API method; the client supplies the transport. */
export abstract class GeneratedMethods {
	/** Sends the request and returns the envelope's result, or throws the API's error. */
	protected abstract call<T>(method: string, path: string, options: CallOptions): Promise<T>;
`)
	for _, op := range s.Ops {
		b.WriteString("\n")
		tsDoc(&b, "\t", op.Summary+"\n\n"+op.Description)
		var args, opts []string
		for _, p := range pathParams(op) {
			args = append(args, camel(p.Name)+": "+tsType(p.Schema))
		}
		if op.Body != nil {
			args = append(args, "request: "+tsType(op.Body))
			opts = append(opts, "body: request")
		}
		if len(queryParams(op)) > 0 {
			args = append(args, "params: "+pascal(op.ID)+"Params = {}")
			opts = append(opts, "query: params")
		}
		path := "\"" + op.Path + "\""
		if len(pathParams(op)) > 0 {
			path = "`" + op.Path + "`"
			for _, p := range pathParams(op) {
				path = strings.Replace(path, "{"+p.Name+"}", "${encodeURIComponent("+camel(p.Name)+")}", 1)
			}
		}
		call := fmt.Sprintf("this.call(%q, %s, { %s })", op.Method, path, strings.Join(opts, ", "))
		if isTrue(op.Result) {
			fmt.Fprintf(&b, "\tasync %s(%s): Promise<void> {\n\t\tawait %s;\n\t}\n", op.ID, strings.Join(args, ", "), strings.Replace(call, "this.call(", "this.call<true>(", 1))
		} else {
			fmt.Fprintf(&b, "\t%s(%s): Promise<%s> {\n\t\treturn %s;\n\t}\n", op.ID, strings.Join(args, ", "), tsType(op.Result), strings.Replace(call, "this.call(", "this.call<"+tsType(op.Result)+">(", 1))
		}
	}
	b.WriteString("}\n")
	return strings.ReplaceAll(b.String(), "{  }", "{}")
}

// tsType is the type of a field: named types by name, others inline.
func tsType(sc *Schema) string {
	switch {
	case sc.Ref != "":
		return refName(sc.Ref)
	case sc.Name != "":
		return sc.Name
	}
	return tsExpr(sc)
}

func tsExpr(sc *Schema) string {
	switch {
	case sc.Const != nil:
		if sc.Const.Tag == "!!str" {
			return fmt.Sprintf("%q", sc.Const.Value)
		}
		return sc.Const.Value
	case sc.Binary:
		return "InputFile"
	case len(sc.Enum) > 0:
		var parts []string
		for _, e := range sc.Enum {
			parts = append(parts, fmt.Sprintf("%q", e))
		}
		return strings.Join(parts, " | ")
	}
	switch sc.Type {
	case "array":
		item := tsType(sc.Items)
		if strings.Contains(item, " | ") {
			item = "(" + item + ")"
		}
		return item + "[]"
	case "integer", "number":
		return "number"
	case "string":
		return "string"
	case "boolean":
		return "boolean"
	case "object":
		return "Record<string, unknown>"
	}
	return "unknown"
}

func tsDoc(b *strings.Builder, indent, text string) {
	lines := wrap(text, 96)
	switch len(lines) {
	case 0:
	case 1:
		fmt.Fprintf(b, "%s/** %s */\n", indent, safeComment(lines[0]))
	default:
		fmt.Fprintf(b, "%s/**\n", indent)
		for _, l := range lines {
			fmt.Fprintf(b, "%s%s\n", indent, strings.TrimRight(" * "+safeComment(l), " "))
		}
		fmt.Fprintf(b, "%s */\n", indent)
	}
}

func safeComment(s string) string {
	return strings.ReplaceAll(s, "*/", "*\\/")
}

func pathParams(op *Operation) []Param {
	var out []Param
	for _, p := range op.Params {
		if p.In == "path" {
			out = append(out, p)
		}
	}
	return out
}

func queryParams(op *Operation) []Param {
	var out []Param
	for _, p := range op.Params {
		if p.In == "query" {
			out = append(out, p)
		}
	}
	return out
}

// isTrue: the method's result is the constant true (nothing to return).
func isTrue(sc *Schema) bool {
	return sc.Const != nil && sc.Const.Value == "true"
}

// camel turns snake_case into camelCase.
func camel(s string) string {
	p := pascal(s)
	return strings.ToLower(p[:1]) + p[1:]
}

func header(comment string) string {
	return comment + " Code generated by server/cmd/sdkgen from spec/bot-api/openapi.yaml. DO NOT EDIT.\n\n"
}
