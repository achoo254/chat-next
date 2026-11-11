// `tunelo authenticator` prints the QR and the setup key from what the
// running service made; the service itself is tested with the pairing.
import { describe, expect, test } from "vitest";
import { groupedKey, qrLines } from "../../src/commands/authenticator.ts";

describe("tunelo authenticator output", () => {
  test("the QR is drawn as black modules on a white ground, reset at each line end", () => {
    const lines = qrLines("otpauth://totp/AI%20Agent:box?secret=ABCDEFGHIJKLMNOP");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line.startsWith("\u001B[30;47m")).toBe(true);
      expect(line.endsWith("\u001B[0m")).toBe(true);
    }
    expect(lines.join("")).toMatch(/[█▀▄]/);
  });

  test("the setup key comes in groups of four", () => {
    expect(groupedKey("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
  });
});
