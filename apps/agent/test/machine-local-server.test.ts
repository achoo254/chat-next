// The machine's one local port: devices' WebSocket as before, Localman's
// requests under /.tunelo/forward as plain HTTP (a WebSocket there is
// refused), and the switch for them from a paired device (MachineSettingsSet,
// answered with MachineInfo carrying the settings).
import { mkdtempSync, rmSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ConfigStore } from "../src/config.ts";
import { Machine } from "../src/machine.ts";
import { fakeProvider } from "./fake-provider.ts";
import { pairedDevice } from "./support/device-link.ts";

const HOST = "m-00000000000000000000000000000a.tunnel.example.com";

let dir = "";
let machine: Machine;
let port = 0;
/** The app runs in a process of its own: ports of the tunelo process itself are never forwarded. */
let app: ChildProcess;
let appPort = 0;
const APP = `require("node:http").createServer((q, s) => s.end("app " + q.headers.host + " " + q.url)).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-machine-"));
  machine = new Machine({ config: new ConfigStore(dir), providers: [fakeProvider()], log: () => undefined });
  port = await machine.start(0);
  app = spawn(process.execPath, ["-e", APP], { stdio: ["ignore", "pipe", "inherit"] });
  appPort = await new Promise<number>((resolve, reject) => {
    app.stdout?.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
    app.once("error", reject);
  });
});

afterEach(async () => {
  await machine.stop();
  app.kill();
  rmSync(dir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; code: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, code: res.headers["tunelo-forward-error"] as string | undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}

function upgrade(path: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("error", () => undefined);
  });
}

describe("the machine's local server", () => {
  test("devices still open the WebSocket; a WebSocket on the forward path is refused; plain HTTP elsewhere asks for an upgrade", async () => {
    expect(await upgrade("/")).toBe("open");
    expect(await upgrade("/.tunelo/forward/socket")).toBe(404);
    expect((await get("/")).status).toBe(426);
  });

  test("the forward path serves only once the tunnel server named the feature, never the machine's own port", async () => {
    const headers = { host: HOST, "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) };
    expect(await get("/.tunelo/forward/hi", headers)).toEqual(expect.objectContaining({ status: 404, code: "TUNELO_FORWARD_001" }));
    machine.localForward.tunnelConnected(`wss://${HOST}/`, ["local-forward"]);
    expect(await get("/.tunelo/forward/hi?x=1", headers)).toEqual(expect.objectContaining({ status: 200, body: `app localhost:${appPort} /hi?x=1` }));
    expect(await get("/.tunelo/forward/", { ...headers, "tunelo-local-port": String(port) })).toEqual(expect.objectContaining({ status: 403, code: "TUNELO_FORWARD_002" }));
  });

  test("a paired device turns forwarding off and on; the answer carries the settings; the change is in the consent log", async () => {
    machine.localForward.tunnelConnected(`wss://${HOST}/`, ["local-forward"]);
    const device = await pairedDevice({ core: machine.core, config: machine.config, audit: machine.audit, localForward: machine.localForward, machineInfo: () => machine.machineInfo() });
    const off = await device.request("1", { case: "machineSettingsSet", value: { localForward: false } });
    expect(off.body.case).toBe("machineInfo");
    if (off.body.case === "machineInfo") expect(off.body.value.settings).toEqual(expect.objectContaining({ localForward: false, localForwardAvailable: true }));
    expect(machine.config.get().localForward).toBe(false);
    const headers = { host: HOST, "tunelo-forward-granted": "1", "tunelo-local-port": String(appPort) };
    expect(await get("/.tunelo/forward/", headers)).toEqual(expect.objectContaining({ status: 403, code: "TUNELO_FORWARD_003" }));
    const on = await device.request("2", { case: "machineSettingsSet", value: { localForward: true } });
    if (on.body.case === "machineInfo") expect(on.body.value.settings?.localForward).toBe(true);
    const entries = machine.audit.list(5).filter((e) => e.action === "local_forward");
    expect(entries.map((e) => [e.device.startsWith("phone"), e.detail])).toEqual([
      [true, "on"],
      [true, "off"],
    ]);
    // Leaving the field unset changes nothing.
    const same = await device.request("3", { case: "machineSettingsSet", value: {} });
    if (same.body.case === "machineInfo") expect(same.body.value.settings?.localForward).toBe(true);
  });
});
