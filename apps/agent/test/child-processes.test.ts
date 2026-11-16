// The terminal process's own children, read with ps and lsof: only direct
// children, each with its folder; a process that ended between the two reads
// keeps no folder; Windows and a failing ps cannot tell.
import { describe, expect, it } from "vitest";
import { childProcesses, parseChildren } from "../src/terminal/child-processes.ts";

const PS = [" 100   1 /usr/libexec/launchd launchd", " 200 100 /Users/me/.local/bin/claude /Users/me/.local/bin/claude --session-id abc", " 201 100 -zsh -zsh", " 300 200 node node x.js"].join("\n");

describe("the terminal process's programs", () => {
  it("lists only its direct children with their command lines", () => {
    expect(parseChildren(PS, 100)).toEqual([
      { pid: 200, command: "/Users/me/.local/bin/claude", args: "/Users/me/.local/bin/claude --session-id abc" },
      { pid: 201, command: "-zsh", args: "-zsh" },
    ]);
  });

  it("adds each one's folder; lsof failing for one that ended still gives the others", async () => {
    const exec = async (cmd: string) => {
      if (cmd === "ps") return PS;
      throw Object.assign(new Error("exit 1"), { stdout: "p200\nfcwd\nn/Users/me/app\n" });
    };
    expect(await childProcesses(100, exec, "darwin")).toEqual([
      { pid: 200, command: "/Users/me/.local/bin/claude", args: "/Users/me/.local/bin/claude --session-id abc", cwd: "/Users/me/app" },
      { pid: 201, command: "-zsh", args: "-zsh", cwd: "" },
    ]);
  });

  it("cannot tell on Windows or when ps fails", async () => {
    expect(await childProcesses(100, async () => PS, "win32")).toBeUndefined();
    expect(await childProcesses(100, async () => Promise.reject(new Error("no ps")), "darwin")).toBeUndefined();
  });
});
