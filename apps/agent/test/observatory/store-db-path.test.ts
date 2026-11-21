// Where the Observatory database lives: TUNELO_HOME first; Windows' local
// (not roaming) app data; next to the config elsewhere.
import { describe, expect, it } from "vitest";
import { observatoryDbFiles, observatoryDbPath } from "../../src/observatory/store/observatory-db-path.ts";

describe("observatoryDbPath", () => {
  it("puts the database under TUNELO_HOME when it is set, on every platform", () => {
    expect(observatoryDbPath({ platform: "linux", env: { TUNELO_HOME: "/srv/tunelo" }, home: "/home/u", configDir: "/srv/tunelo" })).toBe(
      "/srv/tunelo/observatory/observatory.db",
    );
    expect(observatoryDbPath({ platform: "win32", env: { TUNELO_HOME: "D:\\t", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u", configDir: "D:\\t" })).toBe(
      "D:\\t\\observatory\\observatory.db",
    );
  });

  it("uses %LOCALAPPDATA% on Windows, never the roaming %APPDATA%", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "\\\\share\\roaming\\u" };
    expect(observatoryDbPath({ platform: "win32", env, home: "C:\\Users\\u", configDir: "\\\\share\\roaming\\u\\tunelo" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\tunelo\\observatory\\observatory.db",
    );
  });

  it("falls back to ~/AppData/Local on Windows without LOCALAPPDATA", () => {
    expect(observatoryDbPath({ platform: "win32", env: { LOCALAPPDATA: "" }, home: "C:\\Users\\u", configDir: "C:\\Users\\u\\AppData\\Roaming\\tunelo" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\tunelo\\observatory\\observatory.db",
    );
  });

  it("sits next to the agent's config on macOS and Linux", () => {
    expect(observatoryDbPath({ platform: "darwin", env: {}, home: "/Users/u", configDir: "/Users/u/.config/tunelo" })).toBe("/Users/u/.config/tunelo/observatory/observatory.db");
    expect(observatoryDbPath({ platform: "linux", env: { LOCALAPPDATA: "/ignored" }, home: "/home/u", configDir: "/home/u/.config/tunelo" })).toBe(
      "/home/u/.config/tunelo/observatory/observatory.db",
    );
  });

  it("lists SQLite's side files next to the database", () => {
    expect(observatoryDbFiles("/x/o.db")).toEqual(["/x/o.db", "/x/o.db-wal", "/x/o.db-shm", "/x/o.db-journal"]);
  });
});
