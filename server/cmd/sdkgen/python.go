package main

import (
	"fmt"
	"slices"
	"strings"
)

// pyKeywords cannot be identifiers; fields named so use the functional
// TypedDict syntax and arguments get a trailing underscore.
var pyKeywords = []string{"from", "class", "def", "import", "global", "lambda", "pass", "return", "in", "is", "not", "and", "or", "if", "else", "for", "while", "with", "as", "try", "except", "raise", "del", "yield", "assert", "break", "continue", "finally", "nonlocal", "async", "await", "None", "True", "False"}

// python emits sdk/python/chatbot/_generated.py: the models as TypedDicts
// (plain dicts at run time, as JSON decodes them) and the API methods,
// with keyword arguments, on a mixin the hand-written client completes.
func python(s *Spec) string {
	var b strings.Builder
	b.WriteString(header("#"))
	b.WriteString(`from __future__ import annotations

from typing import Any, List, Literal, Mapping, Optional, Required, TypedDict, Union
from urllib.parse import quote

from .files import InputFile

`)
	names := []string{"API_VERSION"}
	for _, sc := range s.Schemas {
		names = append(names, sc.Name)
	}
	slices.Sort(names)
	b.WriteString("__all__ = [\n")
	for _, n := range names {
		fmt.Fprintf(&b, "\t%q,\n", n)
	}
	b.WriteString("]\n\n")
	fmt.Fprintf(&b, "API_VERSION = %q\n\"\"\"Version of the Bot API these types and methods follow.\"\"\"\n", s.Version)
	for _, sc := range s.Schemas {
		b.WriteString("\n\n")
		switch {
		case len(sc.OneOf) > 0:
			var parts []string
			for _, v := range sc.OneOf {
				parts = append(parts, fmt.Sprintf("%q", pyType(v)))
			}
			fmt.Fprintf(&b, "%s = Union[%s]\n", sc.Name, strings.Join(parts, ", "))
			pyDoc(&b, "", sc.Description)
		case sc.Type == "object" || len(sc.AllOf) > 0:
			props, required := s.fields(sc)
			functional := slices.ContainsFunc(props, func(p Prop) bool { return slices.Contains(pyKeywords, p.Name) })
			if functional {
				fmt.Fprintf(&b, "%s = TypedDict(\n\t%q,\n\t{\n", sc.Name, sc.Name)
				for _, p := range props {
					fmt.Fprintf(&b, "\t\t%q: %q,\n", p.Name, pyField(p, required))
				}
				b.WriteString("\t},\n\ttotal=False,\n)\n")
				pyDoc(&b, "", sc.Description)
				continue
			}
			fmt.Fprintf(&b, "class %s(TypedDict, total=False):\n", sc.Name)
			pyDoc(&b, "\t", sc.Description)
			if len(props) == 0 {
				b.WriteString("\tpass\n")
			}
			for _, p := range props {
				fmt.Fprintf(&b, "\t%s: %s\n", p.Name, pyField(p, required))
				pyDoc(&b, "\t", p.Description)
			}
		default:
			fmt.Fprintf(&b, "%s = %s\n", sc.Name, pyExpr(sc))
			pyDoc(&b, "", sc.Description)
		}
	}
	b.WriteString(`

def _present(values: Mapping[str, Any]) -> dict[str, Any]:
	"""The arguments that were given (None means absent)."""
	return {k: v for k, v in values.items() if v is not None}


def _segment(value: Any) -> str:
	"""A path parameter, escaped."""
	return quote(str(value), safe="")


class GeneratedMethods:
	"""Every Bot API method; the client supplies the transport."""

	def _call(self, method: str, path: str, *, query: Optional[dict[str, Any]] = None, body: Optional[dict[str, Any]] = None) -> Any:
		"""Sends the request and returns the envelope's result, or raises the API's error."""
		raise NotImplementedError
`)
	for _, op := range s.Ops {
		var args, keys []string
		for _, p := range pathParams(op) {
			args = append(args, pyArg(p.Name)+": "+pyType(p.Schema))
		}
		named := []string{}
		if op.Body != nil {
			props, required := s.fields(op.Body)
			for _, p := range props {
				if required[p.Name] {
					named = append(named, pyArg(p.Name)+": "+pyType(p.Schema))
				}
			}
			for _, p := range props {
				if !required[p.Name] {
					named = append(named, pyArg(p.Name)+": Optional["+pyType(p.Schema)+"] = None")
				}
			}
			for _, p := range props {
				keys = append(keys, fmt.Sprintf("%q: %s", p.Name, pyArg(p.Name)))
			}
		}
		for _, p := range queryParams(op) {
			named = append(named, pyArg(p.Name)+": Optional["+pyType(p.Schema)+"] = None")
			keys = append(keys, fmt.Sprintf("%q: %s", p.Name, pyArg(p.Name)))
		}
		sig := append([]string{"self"}, args...)
		if len(named) > 0 {
			sig = append(append(sig, "*"), named...)
		}
		result := pyType(op.Result)
		if isTrue(op.Result) {
			result = "None"
		}
		if line := fmt.Sprintf("\tdef %s(%s) -> %s:", snake(op.ID), strings.Join(sig, ", "), result); len(line) <= 100 {
			fmt.Fprintf(&b, "\n%s\n", line)
		} else {
			fmt.Fprintf(&b, "\n\tdef %s(\n\t\t%s,\n\t) -> %s:\n", snake(op.ID), strings.Join(sig, ",\n\t\t"), result)
		}
		pyDoc(&b, "\t\t", op.Summary+"\n\n"+op.Description)
		path := fmt.Sprintf("%q", op.Path)
		if len(pathParams(op)) > 0 {
			path = "f" + path
			for _, p := range pathParams(op) {
				path = strings.Replace(path, "{"+p.Name+"}", "{_segment("+pyArg(p.Name)+")}", 1)
			}
		}
		var opts string
		kind := "body"
		if op.Body == nil {
			kind = "query"
		}
		// mypy reports a returned Any on the line of `return`.
		ignore := ""
		if !isTrue(op.Result) {
			ignore = "  # type: ignore[no-any-return]"
		}
		call := fmt.Sprintf("self._call(%q, %s)%s", op.Method, path, ignore)
		if len(keys) > 0 {
			opts = kind + "=_present(\n\t\t\t\t{\n\t\t\t\t\t" + strings.Join(keys, ",\n\t\t\t\t\t") + ",\n\t\t\t\t}\n\t\t\t)"
			call = fmt.Sprintf("self._call(%s\n\t\t\t%q,\n\t\t\t%s,\n\t\t\t%s,\n\t\t)", ignore, op.Method, path, opts)
		}
		if isTrue(op.Result) {
			fmt.Fprintf(&b, "\t\t%s\n", call)
		} else {
			fmt.Fprintf(&b, "\t\treturn %s\n", call)
		}
	}
	return strings.ReplaceAll(b.String(), "\t", "    ")
}

func pyField(p Prop, required map[string]bool) string {
	t := pyType(p.Schema)
	if required[p.Name] {
		return "Required[" + t + "]"
	}
	return t
}

func pyArg(name string) string {
	if slices.Contains(pyKeywords, name) {
		return name + "_"
	}
	return name
}

func pyType(sc *Schema) string {
	switch {
	case sc.Ref != "":
		return refName(sc.Ref)
	case sc.Name != "":
		return sc.Name
	}
	return pyExpr(sc)
}

func pyExpr(sc *Schema) string {
	switch {
	case sc.Const != nil:
		if sc.Const.Tag == "!!str" {
			return fmt.Sprintf("Literal[%q]", sc.Const.Value)
		}
		switch sc.Const.Value {
		case "true":
			return "Literal[True]"
		case "false":
			return "Literal[False]"
		}
		return "Literal[" + sc.Const.Value + "]"
	case sc.Binary:
		return "InputFile"
	case len(sc.Enum) > 0:
		var parts []string
		for _, e := range sc.Enum {
			parts = append(parts, fmt.Sprintf("%q", e))
		}
		return "Literal[" + strings.Join(parts, ", ") + "]"
	}
	switch sc.Type {
	case "array":
		return "List[" + pyType(sc.Items) + "]"
	case "integer":
		return "int"
	case "number":
		return "float"
	case "string":
		return "str"
	case "boolean":
		return "bool"
	case "object":
		return "dict[str, Any]"
	}
	return "Any"
}

func pyDoc(b *strings.Builder, indent, text string) {
	lines := wrap(text, 88)
	if len(lines) == 0 {
		return
	}
	for i := range lines {
		lines[i] = strings.ReplaceAll(strings.ReplaceAll(lines[i], `\`, `\\`), `"""`, `\"\"\"`)
	}
	if len(lines) == 1 {
		fmt.Fprintf(b, "%s\"\"\"%s\"\"\"\n", indent, lines[0])
		return
	}
	fmt.Fprintf(b, "%s\"\"\"%s\n", indent, lines[0])
	for _, l := range lines[1:] {
		fmt.Fprintf(b, "%s\n", strings.TrimRight(indent+l, " \t"))
	}
	fmt.Fprintf(b, "%s\"\"\"\n", indent)
}
