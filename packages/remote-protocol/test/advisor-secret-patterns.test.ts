import { describe, expect, it } from "vitest";
import { secretShapeIn } from "../src/index.ts";

describe("secretShapeIn", () => {
  it.each([
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"],
    ["bearer", "Authorization: Bearer abcdef0123456789"],
    ["sk", "OPENAI sk-proj-abcdefghijklmnop1234"],
    ["typesafe", "key ts_live_9d1e5b3a7c2f4e6a8b0d"],
    ["github", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github", "gho_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["gitlab", "https://x/ glpat-abcdefghij0123456789xy"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["pem", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn"],
    ["url-userinfo", "remote: https://user:s3cret@gitlab.example.com/repo.git"],
    ["assignment", "DATABASE_PASSWORD=hunter22"],
    ["assignment", "export API_KEY='abcd1234'"],
    ["entropy", "value 8fK2pQ9xZ7mW3vB6nL1tR5yH4cJ0dG2s"],
  ])("finds %s", (id, text) => {
    expect(secretShapeIn(text)).toBe(id);
  });

  it.each([
    "git push failed: rejected because the remote contains work that you do not have locally",
    "commit 3f1c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "ssh://git@github.com/owner/repo.git",
    "Should we use a token bucket or a sliding window?",
    "the password is wrong",
    "src/components/AdvisorMascotBubbleContainer.tsx",
    "set max_token=1000 for the request",
    "max_tokens=4096",
    "use_secret=false",
    "token=null",
    "API_KEY=changeme",
    "password=12345678",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(secretShapeIn(text)).toBeUndefined();
  });
});
