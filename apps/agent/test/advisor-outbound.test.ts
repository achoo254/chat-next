// What may go to Advisor: secret values tunelo holds and JWT/Bearer values are
// hidden, anything else shaped like a secret or naming a sensitive path
// refuses the whole request, and the body returned is exactly what goes out.
import { afterEach, describe, expect, it } from "vitest";
import { REFUSED_SECRET, outboundBody } from "../src/advisor/advisor-outbound.ts";
import type { WeighBody } from "../src/advisor/jev-client.ts";
import { forgetSecrets, rememberSecret } from "../src/mcp/redact.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";

afterEach(() => forgetSecrets());

// The machine's own check: the real home, as mentionsSensitive reads "~".
const isSensitive = createSensitiveCheck({ configDir: "/nonexistent/tunelo" });
const body = (over: Partial<WeighBody>): WeighBody => ({ kind: "decision", question: "Which way?", options: ["Rebase", "Merge"], context: "", ...over });

describe("outboundBody", () => {
  it("lets an abstract request through unchanged", () => {
    const b = body({ context: "Push was rejected: the remote branch has commits the local one lacks." });
    expect(outboundBody(b, isSensitive)).toEqual({ ok: true, body: b });
  });

  it("hides a secret value tunelo holds, and JWT and Bearer values, in every field", () => {
    rememberSecret("hunter2-the-saved-password");
    const out = outboundBody(
      body({
        question: "Login with hunter2-the-saved-password fails?",
        options: ["Retry hunter2-the-saved-password", "Reset"],
        context: "header Bearer abc.def.ghi and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      }),
      isSensitive,
    );
    expect(out.ok).toBe(true);
    const sent = JSON.stringify(out.ok ? out.body : {});
    expect(sent).not.toContain("hunter2-the-saved-password");
    expect(sent).not.toContain("abc.def.ghi");
    expect(sent).not.toContain("eyJhbGci");
    expect(sent).toContain("[hidden]");
  });

  it.each([
    ["a GitHub token", { context: "remote uses ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["a GitLab token in a URL", { context: "https://oauth2:glpat-abcdefghij0123456789xy@gitlab.example.com/a.git" }],
    ["a TypeSafe key in an option", { options: ["use ts_live_0123456789abcdef0123", "skip"] }],
    ["a private key block", { context: "-----BEGIN RSA PRIVATE KEY-----" }],
    ["a password assignment", { question: "Is DB_PASSWORD=supersecret42 right?" }],
    ["a random-looking string", { context: "token 8fK2pQ9xZ7mW3vB6nL1tR5yH4cJ0dG2s" }],
    ["a sensitive path", { context: "cat ~/.ssh/id_ed25519 failed" }],
  ])("refuses %s, sending nothing", (_name, over) => {
    expect(outboundBody(body(over), isSensitive)).toEqual({ ok: false, why: REFUSED_SECRET });
  });
});
