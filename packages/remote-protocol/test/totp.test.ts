import { describe, expect, it } from "vitest";
import {
  TOTP_SECRET_BYTES,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  isTotpSecret,
  normalizeTotpCode,
  totpCandidates,
  totpCode,
  totpCodeAt,
  totpStep,
  totpUri,
  utf8,
  verifyTotp,
} from "../src/index.ts";

// RFC 6238 appendix B, SHA-1 rows: the seed is ASCII "12345678901234567890"
// and the published 8-digit values end with the 6 digits authenticators show.
const RFC_SECRET = utf8("12345678901234567890");
const RFC_VECTORS: [seconds: number, eightDigits: string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
  it.each(RFC_VECTORS)("matches the RFC vector at T=%i", (seconds, eight) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(eight.slice(-6));
  });

  it("matches RFC 4226 HOTP values by step", () => {
    // RFC 4226 appendix D, counters 0 and 9.
    expect(totpCodeAt(RFC_SECRET, 0)).toBe("755224");
    expect(totpCodeAt(RFC_SECRET, 9)).toBe("520489");
  });

  it("uses 30-second steps", () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
  });

  it("accepts the previous, current and next step only", () => {
    const secret = RFC_SECRET;
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(totpCandidates(secret, now)).toEqual([step - 1, step, step + 1].map((s) => totpCodeAt(secret, s)));
    expect(verifyTotp(secret, totpCodeAt(secret, step - 1), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, step + 1), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, step + 2), now)).toBe(false);
    expect(verifyTotp(secret, totpCodeAt(secret, step - 2), now)).toBe(false);
  });

  it("verifies typed codes with spaces and refuses junk", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
    expect(verifyTotp(secret, "abcdef", now)).toBe(false);
    expect(normalizeTotpCode(" 123-456 ")).toBe("123456");
    expect(normalizeTotpCode("1234567")).toBeNull();
  });

  it("makes 20-byte secrets", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(TOTP_SECRET_BYTES);
    expect(isTotpSecret(secret)).toBe(true);
    expect(isTotpSecret(new Uint8Array(16))).toBe(false);
  });
});

describe("base32", () => {
  it("matches RFC 4648 vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(utf8(plain))).toBe(encoded);
      expect(base32Decode(encoded)).toEqual(utf8(plain));
    }
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("round-trips secrets and accepts how people copy them", () => {
    const secret = generateTotpSecret();
    const text = base32Encode(secret);
    expect(base32Decode(text)).toEqual(secret);
    expect(base32Decode(`${text.toLowerCase().replace(/(.{4})/g, "$1 ")}==`)).toEqual(secret);
    expect(() => base32Decode("ABC1")).toThrow();
  });
});

describe("otpauth URI", () => {
  it("spells out every parameter", () => {
    const uri = new URL(totpUri({ secret: RFC_SECRET, label: "Mac mini", issuer: "Chat" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Chat:Mac mini");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      issuer: "Chat",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });
});
