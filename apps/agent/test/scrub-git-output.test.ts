// git's output as Advisor's AI reads it: no password or token in a URL, no
// path of the machine, no private key, nothing shaped like a secret, no
// terminal control, and a bounded size; a commit hash and ordinary words stay.
import { describe, expect, it } from "vitest";
import { FAILURE_OUTPUT_MAX_BYTES, cutBytes, hideSecretShapes, scrubGitOutput } from "../src/advisor/scrub-git-output.ts";
import { forgetSecrets, rememberSecret } from "../src/mcp/redact.ts";

const GLPAT = ["glpat", "Ab3dEf6hIj9kLm2nOp5q"].join("-"); // built at runtime so secret scanners skip this fake token
const GHP = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");

describe("scrubGitOutput", () => {
  it("drops the user and token of a URL, whatever host", () => {
    const out = scrubGitOutput(`fatal: unable to access 'https://oauth2:${GLPAT}@gitlab.example.com/team/app.git/': The requested URL returned error: 403\nTo https://x-access-token:${GHP}@github.com/me/app.git`);
    expect(out).not.toContain(GLPAT);
    expect(out).not.toContain(GHP);
    expect(out).not.toContain("oauth2");
    expect(out).toContain("https://gitlab.example.com/team/app.git/");
    expect(out).toContain("returned error: 403");
  });

  it("names the repository's folder and the home folder relatively", () => {
    const root = "/Users/someone/work/app";
    const out = scrubGitOutput(`error: failed to push some refs to '${root}/.git'\nhint: see /Users/someone/.gitconfig`, { root, home: "/Users/someone" });
    expect(out).toContain("'./.git'");
    expect(out).toContain("~/.gitconfig");
    expect(out).not.toContain("/Users/someone");
  });

  it("hides a private key block, tokens, secrets tunelo holds and random-looking runs; keeps a commit hash", () => {
    rememberSecret("correct-horse-battery-staple-9");
    try {
      const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
      const out = scrubGitOutput(
        [pem, `token=${GHP}`, "password is correct-horse-battery-staple-9", "Kq8vR2mX7pL4nT9wZ3yB6cF1hJ5sD0gA8eU2iO", "commit 4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", "! [rejected] main -> main (fetch first)"].join("\n"),
      );
      expect(out).not.toContain("b3BlbnNzaC1rZXkt");
      expect(out).not.toContain("PRIVATE KEY");
      expect(out).not.toContain(GHP);
      expect(out).not.toContain("correct-horse-battery-staple-9");
      expect(out).not.toContain("Kq8vR2mX7pL4nT9wZ3yB6cF1hJ5sD0gA8eU2iO");
      expect(out).toContain("4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39");
      expect(out).toContain("! [rejected] main -> main (fetch first)");
    } finally {
      forgetSecrets();
    }
  });

  it("takes out terminal colors and control characters, keeps lines, and stays within its size", () => {
    const esc = String.fromCharCode(0x1b);
    const out = scrubGitOutput(`${esc}[31merror${esc}[0m: one\r\ntwo\u0007\rthree`);
    expect(out).toBe("error: one\ntwo\nthree");
    const long = scrubGitOutput("é".repeat(FAILURE_OUTPUT_MAX_BYTES));
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(FAILURE_OUTPUT_MAX_BYTES);
    expect(long.endsWith("… (cut)")).toBe(true);
    expect(cutBytes("short", 100)).toBe("short");
  });

  it("hideSecretShapes leaves ordinary text alone", () => {
    expect(hideSecretShapes("max_tokens=4096 and a normal sentence")).toBe("max_tokens=4096 and a normal sentence");
  });
});
