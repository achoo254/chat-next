// The short subject over the director's head: a file name, a command's first
// word, a host, an MCP tool's name; never a path, a whole command or a query,
// and nothing at all for a sensitive call (docs/office-wire.md, part 5).
import { describe, expect, it } from "vitest";
import { SUBJECT_MAX, officeSubject } from "../src/office/office-subject.ts";
import type { ToolKind } from "../src/providers/types.ts";

const subject = (kind: ToolKind, summary: string, name = "Tool", sensitive = false) => officeSubject({ kind, name, summary, sensitive });

describe("office subject", () => {
  it("is the file name, without its folder, for reads and edits", () => {
    expect(subject("read", "apps/agent/src/core/agent-core.ts")).toBe("agent-core.ts");
    expect(subject("edit", "C:\\Users\\me\\project\\notes.md")).toBe("notes.md");
  });

  it("is the command's first word for a shell, never the rest", () => {
    expect(subject("shell", "FOO=secret pnpm test --filter private-thing")).toBe("pnpm");
    expect(subject("shell", "git commit -m 'private message'")).toBe("git");
  });

  it("is empty for searches", () => {
    expect(subject("search", "password in src")).toBe("");
  });

  it("is the host of a URL for the web, empty for a query", () => {
    expect(subject("web", "https://docs.example.com/path?token=abc")).toBe("docs.example.com");
    expect(subject("web", "how to hide a body")).toBe("");
  });

  it("is the tool's own name for MCP", () => {
    expect(subject("mcp", "github · create_issue", "mcp__github__create_issue")).toBe("create_issue");
    expect(subject("mcp", "", "mcp__x")).toBe("");
  });

  it("is empty for other tools", () => {
    expect(subject("other", "anything")).toBe("");
    expect(subject("todo", "anything")).toBe("");
  });

  it("is empty for a sensitive call, whatever it is", () => {
    expect(subject("read", ".ssh/id_ed25519", "Read", true)).toBe("");
    expect(subject("shell", "cat ~/.aws/credentials", "Bash", true)).toBe("");
  });

  it("is cut to SUBJECT_MAX characters and loses control characters", () => {
    const long = `${"a".repeat(100)}.ts`;
    const s = subject("read", `src/${long}`);
    expect([...s]).toHaveLength(SUBJECT_MAX);
    expect(s.endsWith("…")).toBe(true);
    expect(subject("read", "src/bad\u0007name.ts")).toBe("badname.ts");
  });
});
