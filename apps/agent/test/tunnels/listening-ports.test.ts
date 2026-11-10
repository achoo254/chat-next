// What listens on 127.0.0.1, read from sample lsof / ss / netstat / tasklist / ps
// output, and the ports the machine refuses beyond the shared list: debug
// flags on command lines, Claude Code IDE locks, tunelo's own processes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FALLBACK_DEBUG_PORTS, ForwardDenyList, debugPortsOf, idePorts, randomDebugPort } from "../../src/tunnels/forward-deny-ports.ts";
import { parseLsof, parseNetstat, parseProcessLines, parseSs, parseTasklist } from "../../src/tunnels/listening-ports.ts";

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
  "p900",
  "cvite",
  "f9",
  "n[::1]:5174",
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
  TCP    [::1]:5174             [::]:0                 LISTENING       4567
  TCP    [fe80::1%5]:7000       [::]:0                 LISTENING       4
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
      { port: 5174, pid: 900, name: "vite" },
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
      { port: 5174, pid: 4567, name: "node.exe" },
    ]);
  });

  test("ss (Linux without lsof): loopback-reachable sockets, the process when it is the user's own", () => {
    const ss = [
      'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=605,fd=14))',
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=1234,fd=20))',
      "LISTEN 0      128             [::]:22            [::]:*",
      'LISTEN 0      511                *:8080             *:*    users:(("java",pid=77,fd=3))',
      'LISTEN 0      100     192.168.1.20:5432       0.0.0.0:*    users:(("postgres",pid=9,fd=5))',
      'LISTEN 0      100            [::1]:5173          [::]:*    users:(("vite",pid=1234,fd=21))',
      "",
    ].join("\n");
    expect(parseSs(ss)).toEqual([
      { port: 22, pid: 0, name: "" },
      { port: 53, pid: 605, name: "systemd-resolve" },
      { port: 3000, pid: 1234, name: "node" },
      { port: 5173, pid: 1234, name: "vite" },
      { port: 8080, pid: 77, name: "java" },
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
    ["node server.js HOME=/Users/a NODE_OPTIONS=--inspect", [9229]],
    ["kubectl proxy", [8001]],
    ["kubectl proxy --port=8011", [8011]],
    ["/usr/local/bin/kubectl --context dev proxy -p 8012", [8012]],
    ["kubectl get pods", []],
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

  test("a debug port picked at random refuses every port of that process", async () => {
    expect(randomDebugPort("node --inspect=0 app.js")).toBe(true);
    expect(randomDebugPort("node --inspect=127.0.0.1:0 app.js")).toBe(true);
    expect(randomDebugPort("chrome --remote-debugging-port=0")).toBe(true);
    expect(randomDebugPort("node --inspect=9229 app.js")).toBe(false);
    const deny = new ForwardDenyList({
      configDir: dir,
      ownPorts: () => [],
      extraPorts: () => [],
      listening: async () => [
        { port: 41000, pid: 10, name: "node" },
        { port: 41001, pid: 10, name: "node" },
        { port: 41002, pid: 11, name: "node" },
      ],
      processes: async () => [{ pid: 10, command: "node --inspect=0 app.js" }],
      runs: () => [],
      claudeHomes: () => [],
    });
    expect([await deny.denies(41000), await deny.denies(41001), await deny.denies(41002)]).toEqual([true, true, false]);
  });

  test("a failed reading keeps the last good one; before any, common debug ports are refused", async () => {
    let fail = true;
    let now = 0;
    const logs: string[] = [];
    const deny = new ForwardDenyList({
      configDir: dir,
      ownPorts: () => [],
      extraPorts: () => [],
      listening: async () => [],
      processes: async () => {
        if (fail) throw new Error("ps timed out");
        return [{ pid: 5, command: "node --inspect=42000 x.js" }];
      },
      runs: () => [],
      claudeHomes: () => [],
      log: (l) => logs.push(l),
      now: () => now,
    });
    for (const p of FALLBACK_DEBUG_PORTS) expect(await deny.denies(p)).toBe(true);
    expect(logs.join("\n")).toContain("could not read running processes");
    fail = false;
    now += 10_000;
    expect(await deny.denies(42000)).toBe(true);
    expect(await deny.denies(8001)).toBe(false);
    fail = true;
    now += 10_000;
    expect(await deny.denies(42000)).toBe(true);
    expect(await deny.denies(8001)).toBe(false);
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
