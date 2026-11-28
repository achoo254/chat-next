// Screenshots through tunelo-capture (ADR 0031) with a fake child on the
// other end of its stdin and stdout: ready makes it available, a device's
// request waits for the overlay, the picture goes back in pieces and its file
// is deleted, a cancel and an error reach the device, an exit fails what is
// open and starts it again; the shortcut a user writes is normalized.
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureService, type CapturePiece, PIECE_BYTES } from "../src/capture/capture-service.ts";
import { captureLangOf, normalizeHotkey, readCaptureSettings, writeCaptureSettings } from "../src/capture/capture-settings.ts";
import { runCaptureHotkey, shownHotkey } from "../src/commands/capture-hotkey.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly commands: Record<string, unknown>[] = [];
  constructor() {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let at = buffered.indexOf("\n");
      while (at >= 0) {
        this.commands.push(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>);
        buffered = buffered.slice(at + 1);
        at = buffered.indexOf("\n");
      }
    });
  }
  say(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  dirs.push(dir);
  const bin = join(dir, "tunelo-capture");
  writeFileSync(bin, "");
  const children: FakeChild[] = [];
  const remembered: string[] = [];
  const outDir = join(dir, "out");
  const service = new CaptureService({
    configDir: dir,
    outDir,
    hotkey: () => "Ctrl+Alt+A",
    enabled: () => true,
    lang: () => "vi",
    rememberLang: (lang) => remembered.push(lang),
    log: () => undefined,
    env: { TUNELO_CAPTURE_BIN: bin },
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { service, children, outDir, remembered };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

describe("tunelo-capture under tunelo", () => {
  it("is available once it says ready, with the shortcut it registered", async () => {
    const { service, children } = setup();
    service.start();
    expect(service.info()).toEqual({ available: false, hotkey: "" });
    children[0]?.say({ event: "ready", version: "0.1.0", wire: 1, hotkey: "Ctrl+Alt+A" });
    await until(() => service.info().available);
    expect(service.info().hotkey).toBe("Ctrl+Alt+A");
    service.close();
  });

  it("opens the overlay for a device and sends the picture back in pieces, then deletes its file", async () => {
    const { service, children, outDir } = setup();
    service.start();
    const child = children[0] as FakeChild;
    child.say({ event: "ready", version: "0.1.0", wire: 1, hotkey: "" });
    await until(() => service.info().available);
    const pieces: CapturePiece[] = [];
    const opened = service.request("req-00001", (p) => pieces.push(p));
    await until(() => child.commands.length === 1);
    expect(child.commands[0]).toEqual({ cmd: "capture_interactive", id: "req-00001", origin: "chat" });
    child.say({ event: "opened", id: "req-00001" });
    await opened;
    const file = join(outDir, "capture-1.png");
    const bytes = Buffer.alloc(PIECE_BYTES + 10, 7);
    writeFileSync(file, bytes);
    child.say({ event: "captured", id: "req-00001", origin: "chat", action: "main", file, width: 10, height: 10 });
    await until(() => pieces.some((p) => p.last));
    expect(pieces).toHaveLength(2);
    const [first, second] = pieces;
    expect(first).toMatchObject({ outcome: "captured", name: "capture-1.png", mimeType: "image/png", size: bytes.length, offset: 0, last: false });
    expect(second).toMatchObject({ outcome: "captured", offset: PIECE_BYTES, last: true });
    expect(existsSync(file)).toBe(false);
    service.close();
  });

  it("shows the overlay in the device's language and keeps it for the shortcut", async () => {
    const { service, children, remembered } = setup();
    service.start();
    const child = children[0] as FakeChild;
    child.say({ event: "ready", version: "0.1.0", wire: 1, hotkey: "" });
    await until(() => service.info().available);
    const opened = service.request("req-00005", () => undefined, "zh-CN");
    await until(() => child.commands.length === 2);
    expect(child.commands).toEqual([
      { cmd: "set_lang", lang: "zh-CN" },
      { cmd: "capture_interactive", id: "req-00005", origin: "chat" },
    ]);
    expect(remembered).toEqual(["zh-CN"]);
    child.say({ event: "opened", id: "req-00005" });
    await opened;
    service.close();
  });

  it("tells the device of a cancel, and refuses a request the overlay cannot open", async () => {
    const { service, children } = setup();
    service.start();
    const child = children[0] as FakeChild;
    child.say({ event: "ready", version: "0.1.0", wire: 1, hotkey: "" });
    await until(() => service.info().available);
    const pieces: CapturePiece[] = [];
    const first = service.request("req-00002", (p) => pieces.push(p));
    child.say({ event: "opened", id: "req-00002" });
    await first;
    child.say({ event: "cancelled", id: "req-00002" });
    await until(() => pieces.length === 1);
    expect(pieces[0]).toEqual({ outcome: "cancelled", last: true });
    const busy = service.request("req-00003", () => undefined);
    child.say({ event: "error", id: "req-00003", code: "busy", message: "a capture is already open" });
    await expect(busy).rejects.toThrow(/already open/);
    service.close();
  });

  it("is refused while tunelo-capture does not run", async () => {
    const { service } = setup();
    await expect(service.request("req-00004", () => undefined)).rejects.toThrow(/not available/);
  });

  it("fails what is open when it exits, and starts it again", async () => {
    const { service, children } = setup();
    service.start();
    const child = children[0] as FakeChild;
    child.say({ event: "ready", version: "0.1.0", wire: 1, hotkey: "" });
    await until(() => service.info().available);
    const pieces: CapturePiece[] = [];
    const opened = service.request("req-00005", (p) => pieces.push(p));
    child.say({ event: "opened", id: "req-00005" });
    await opened;
    child.emit("exit", 1);
    expect(pieces).toEqual([{ outcome: "failed", message: "the capture process stopped", last: true }]);
    expect(service.info().available).toBe(false);
    await until(() => children.length === 2);
    service.close();
  });
});

describe("the screenshot shortcut", () => {
  it("is written as tunelo-capture takes it, whatever way the user writes it", () => {
    expect(normalizeHotkey("ctrl+option+a")).toBe("Ctrl+Alt+A");
    expect(normalizeHotkey("⌃⌥A")).toBe("Ctrl+Alt+A");
    expect(normalizeHotkey("⌘⇧4")).toBe("Shift+Super+4");
    expect(normalizeHotkey("Shift+Ctrl+F2")).toBe("Ctrl+Shift+F2");
    expect(normalizeHotkey("a")).toBeUndefined();
    expect(normalizeHotkey("ctrl+alt")).toBeUndefined();
    expect(normalizeHotkey("ctrl+a+b")).toBeUndefined();
  });

  it("reads like the system's own on a Mac", () => {
    expect(shownHotkey("Ctrl+Alt+A", "darwin")).toBe("⌃⌥A");
    expect(shownHotkey("Ctrl+Alt+A", "win32")).toBe("Ctrl+Alt+A");
    expect(shownHotkey("", "darwin")).toBe("off");
  });

  it("is changed, turned off and restored with tunelo config capture-hotkey", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-cfg-"));
    dirs.push(dir);
    const out: string[] = [];
    const err: string[] = [];
    const run = (arg?: string) => runCaptureHotkey(arg, dir, (l) => out.push(l), (l) => err.push(l));
    expect(run("cmd+shift+s")).toBe(0);
    expect(readCaptureSettings(dir).hotkey).toBe("Shift+Super+S");
    expect(run("off")).toBe(0);
    expect(readCaptureSettings(dir).hotkey).toBe("");
    expect(run("default")).toBe(0);
    expect(readCaptureSettings(dir).hotkey).toBe("Ctrl+Alt+A");
    expect(run("banana")).toBe(1);
    expect(err.at(-1)).toMatch(/not a shortcut/);
    writeCaptureSettings(dir, { enabled: false });
    expect(readCaptureSettings(dir)).toEqual({ enabled: false });
    expect(JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"))).toEqual({ enabled: false });
  });
});

describe("the overlay's language", () => {
  it("is one the overlay has, from the tag a device sends", () => {
    expect(captureLangOf("vi")).toBe("vi");
    expect(captureLangOf("en-US")).toBe("en");
    expect(captureLangOf("zh-CN")).toBe("zh-CN");
    expect(captureLangOf("fr")).toBeUndefined();
    expect(captureLangOf("")).toBeUndefined();
  });

  it("is kept next to the shortcut, and a broken one is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-lang-"));
    dirs.push(dir);
    runCaptureHotkey("ctrl+shift+s", dir, () => undefined, () => undefined);
    writeCaptureSettings(dir, { ...readCaptureSettings(dir), lang: "en" });
    runCaptureHotkey("ctrl+alt+a", dir, () => undefined, () => undefined);
    expect(readCaptureSettings(dir)).toEqual({ hotkey: "Ctrl+Alt+A", lang: "en" });
    writeFileSync(join(dir, "capture.json"), JSON.stringify({ lang: "klingon" }));
    expect(readCaptureSettings(dir)).toEqual({});
  });
});
