import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// macOS puts temp folders under /var/folders, and /var is a sensitive path
// of the agent (safety/sensitive-paths.ts), so a test home made there reads
// as sensitive. Tests take their temp folders from /private/tmp instead; the
// rule itself stays as it is. Linux (CI) already uses /tmp.
const tempRoot = process.platform === "darwin" && tmpdir().startsWith("/var/") ? mkdtempSync("/private/tmp/tunelo-agent-test-") : undefined;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Shared 16 GB machine: at most two workers however the suite starts.
    maxWorkers: 2,
    env: {
      // Keys go to a 0600 file in the test's config folder, never the real Keychain or DPAPI.
      TUNELO_KEYSTORE: "file",
      ...(tempRoot ? { TMPDIR: tempRoot } : {}),
    },
  },
});
