// What listens on 127.0.0.1, read from sample lsof / netstat / tasklist / ps
// output, and the ports the machine refuses beyond the shared list: debug
// flags on command lines, Claude Code IDE locks, tunelo's own processes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ForwardDenyList, debugPortsOf, idePorts } from "../../src/tunnels/forward-deny-ports.ts";
import { parseLsof, parseNetstat, parseProcessLines, parseTasklist } from "../../src/tunnels/listening-ports.ts";

const LSOF = [
  "p501",
  "cnode",
  "f21",
  "n*:5173",
  "f22",
  "n127.0.0.1:9229",
  "p600",
  "cGoogle Chrome Helper",
  "f30",
  "n[::1]:9222",
  "f31",
  "n127.0.0.1:9222",
  "p700",
  "cpostgres",
  "f5",
  "n192.168.1.20:5432",
  "f6",
  "n[::]:5433",
  "p800",
  "cweird\u001bname",
  "f7",
  "n127.0.0.1:3000->127.0.0.1:50000",
  "f8",
  "n0.0.0.0:3001",
  "",
].join("\n");

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         4567
  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     4567
  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4
  TCP    [::]:445               [::]:0                 LISTENING       4
`;

const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"svchost.exe","1012","Services","0","12,000 K"
"node.exe","4567","Console","1","50,000 K"
`;

describe("parsers", () => {
  test("lsof: sockets reachable on 127.0.0.1 only, the process of each, no connected sockets", () => {
    expect(parseLsof(LSOF)).toEqual([
      { port: 3001, pid: 800, name: "weirdname" },
      { port: 5173, pid: 501, name: "node" },
      { port: 5433, pid: 700, name: "postgres" },
      { port: 9222, pid: 600, name: "Google Chrome Helper" },
      { port: 9229, pid: 501, name: "node" },
    ]);
  });

  test("netstat: listening rows by their foreign address (state words differ by language), names from tasklist", () => {
    expect(parseNetstat(NETSTAT, parseTasklist(TASKLIST))).toEqual([
      { port: 135, pid: 1012, name: "svchost.exe" },
      { port: 445, pid: 4, name: "" },
      { port: 5173, pid: 4567, name: "node.exe" },
    ]);
  });

  test("ps lines", () => {
    expect(parseProcessLines("  12 /usr/bin/node --inspect app.js\n 13 \n99 bash -l\n")).toEqual([
      { pid: 12, command: "/usr/bin/node --inspect app.js" },
      { pid: 99, command: "bash -l" },
    ]);
  });
});

describe("debug ports on command lines", () => {
  test.each([
    ["node --inspect app.js", [9229]],
    ["node --inspect-brk=9333 app.js", [9333]],
    ["node --inspect=0.0.0.0:9444 app.js", [9444]],
    ["node --inspect-wait=[::1]:9555 app.js", [9555]],
    ["node --inspect-port=9666 app.js", [9666]],
    ["/Applications/Chrome --remote-debugging-port=9333 --user-data-dir=/tmp/x", [9333]],
    ["java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5006 -jar a.jar", [5006]],
    ["node --inspection-report app.js", []],
    ["node app.js --port 3000", []],
  ])("%s", (command, ports) => {
    expect(debugPortsOf(command)).toEqual(ports);
  });
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-deny-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ports the machine refuses", () => {
  test("IDE lock files of every Claude folder", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(join(a, "ide"), { recursive: true });
    mkdirSync(join(b, "ide"), { recursive: true });
    writeFileSync(join(a, "ide", "45123.lock"), "{}");
    writeFileSync(join(b, "ide", "51000.lock"), "{}");
    writeFileSync(join(b, "ide", "notes.lock"), "{}");
    writeFileSync(join(b, "ide", "99999.lock"), "{}");
    expect(idePorts([a, b, join(dir, "missing")]).sort()).toEqual([45123, 51000]);
  });

  test("the profiles' IDE locks, the control port, tunelo's processes, debug ports; read once per few seconds", async () => {
    const home = join(dir, "claude-profiles", "p1", "home", "ide");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "47000.lock"), "{}");
    writeFileSync(join(dir, "control.json"), JSON.stringify({ port: 48000, token: "t", pid: process.pid }));
    let reads = 0;
    let now = 1_000;
    const deny = new ForwardDenyList({
      configDir: dir,
      ownPorts: () => [49000],
      extraPorts: () => [49001],
      listening: async () => {
        reads++;
        return [
          { port: 50000, pid: 4321, name: "tunelo" },
          { port: 50001, pid: 77, name: "node" },
          { port: 50002, pid: 88, name: "node" },
        ];
      },
      processes: async () => [{ pid: 88, command: "node --inspect=50003 x.js" }],
      runs: () => [{ pid: 77, inspectorPort: 50004 }],
      now: () => now,
    });
    for (const p of [9222, 47000, 48000, 49000, 49001, 50000, 50001, 50003, 50004]) expect(await deny.denies(p)).toBe(true);
    expect(await deny.denies(50002)).toBe(false);
    expect(await deny.denies(5173)).toBe(false);
    expect(reads).toBe(1);
    now += 5_000;
    await deny.denies(5173);
    expect(reads).toBe(2);
  });

  test("an OS listing that fails leaves the known ports refused", async () => {
    const deny = new ForwardDenyList({
      configDir: dir,
      ownPorts: () => [49000],
      extraPorts: () => [],
      listening: async () => {
        throw new Error("lsof missing");
      },
      processes: async () => {
        throw new Error("ps missing");
      },
      runs: () => [],
      claudeHomes: () => [],
    });
    expect(await deny.denies(49000)).toBe(true);
    expect(await deny.denies(9229)).toBe(true);
    expect(await deny.denies(5173)).toBe(false);
    expect((await deny.current()).listening).toEqual([]);
  });
});
