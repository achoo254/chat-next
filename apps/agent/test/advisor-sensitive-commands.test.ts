// Commands that could reach Advisor's key are ones only a person at the
// machine runs: an AI's command naming them gets a red approval card.
import { describe, expect, it } from "vitest";
import { createSensitiveCheck, mentionsSensitive } from "../src/safety/sensitive-paths.ts";
import { tempDir } from "./harness.ts";

const home = tempDir("advisor-home-");
const isSensitive = createSensitiveCheck({ home });
const sensitive = (command: string) => mentionsSensitive(command, isSensitive, { home, cwd: home });

describe("commands around Advisor's key", () => {
  it("tunelo advisor in any form is sensitive", () => {
    expect(sensitive("tunelo advisor set-key")).toBe(true);
    expect(sensitive("echo $KEY | tunelo advisor set-key")).toBe(true);
    expect(sensitive("tunelo.exe advisor remove-key")).toBe(true);
    expect(sensitive("TUNELO ADVISOR status")).toBe(true);
  });

  it("security reading tunelo's Keychain items, or dumping the keychain, is sensitive", () => {
    expect(sensitive("security find-generic-password -s com.hoandat.tunelo -a session-key -w")).toBe(true);
    expect(sensitive("/usr/bin/security find-generic-password -w -s 'com.hoandat.tunelo'")).toBe(true);
    expect(sensitive("security delete-generic-password -s com.hoandat.tunelo")).toBe(true);
    expect(sensitive("security dump-keychain -d login.keychain")).toBe(true);
    expect(sensitive("security export -k login.keychain -t identities")).toBe(true);
  });

  it("printing any password item, or naming tunelo's items by account alone, is sensitive", () => {
    expect(sensitive("security find-generic-password -a session-key -w")).toBe(true);
    expect(sensitive("security find-generic-password -a machine-key")).toBe(true);
    expect(sensitive("security find-generic-password -s other.service -w")).toBe(true);
    expect(sensitive("security find-internet-password -s example.com -g")).toBe(true);
    expect(sensitive("security find-generic-password -gw -l foo")).toBe(true);
  });

  it("ordinary commands stay ordinary", () => {
    expect(sensitive("tunelo status")).toBe(false);
    expect(sensitive("npm test -- advisor")).toBe(false);
    expect(sensitive("security find-identity -v -p codesigning")).toBe(false);
    expect(sensitive("grep -rn security src")).toBe(false);
  });
});
