import { defineConfig } from "vitest/config";
import { testTempRun } from "./test/support/test-temp-root.ts";

// Every temp folder of the run goes into one folder of its own, removed once
// the run ends (test/support/test-temp-root.ts tells where, and how to keep it).
const tempRun = testTempRun();

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Shared 16 GB machine: at most two workers however the suite starts.
    maxWorkers: 2,
    globalSetup: ["./test/support/test-temp-root.ts"],
    env: {
      // Keys go to a 0600 file in the test's config folder, never the real Keychain or DPAPI.
      TUNELO_KEYSTORE: "file",
      TMPDIR: tempRun,
    },
  },
});
