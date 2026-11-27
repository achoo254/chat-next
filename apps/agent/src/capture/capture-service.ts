// Screenshots of this machine's screens (ADR 0031): tunelo runs
// tunelo-capture as its child and talks to it over its stdin and stdout, one
// JSON object a line (docs/capture-wire.md). A device asks for a capture from
// the Chat composer (CaptureRequest): the overlay opens on the machine, the
// user picks and marks a region, and the picture goes back to that device
// only, in pieces (CaptureResult), then its file is deleted. The global
// shortcut opens the same overlay by itself; its picture stays on the
// clipboard. The shortcut is `capture.hotkey` of the config (Ctrl+Alt+A by
// default), changed with `tunelo config capture-hotkey` while tunelo runs.
//
// Which binary: TUNELO_CAPTURE_BIN, else `<config>/capture/bin/current/`,
// else the agent's own folder (as tunelo-term-host). None: no capture, and the
// composer uses the browser's own.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const CAPTURE_BINARY = process.platform === "win32" ? "tunelo-capture.exe" : "tunelo-capture";
export const DEFAULT_HOTKEY = "Ctrl+Alt+A";
/** A piece of a picture sent to a device. */
export const PIECE_BYTES = 1024 * 1024;
/** The overlay must be up this fast after a device asked. */
const OPEN_TIMEOUT_MS = 8_000;
/** Restarts after an unexpected exit wait this long, doubling up to the max. */
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;

export function locateCapture(configDir: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const fromEnv = env.TUNELO_CAPTURE_BIN;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  for (const candidate of [join(configDir, "capture", "bin", "current", CAPTURE_BINARY), join(dirname(execPath), CAPTURE_BINARY)]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** One piece of a capture's answer to a device (CaptureResult without the request id). */
export type CapturePiece =
  | { outcome: "captured"; name: string; mimeType: string; size: number; offset: number; data: Uint8Array; last: boolean }
  | { outcome: "cancelled"; last: true }
  | { outcome: "failed"; message: string; last: true };

/** An event of tunelo-capture (docs/capture-wire.md). */
type CaptureEvent =
  | { event: "ready"; version: string; wire: number; hotkey: string }
  | { event: "opened"; id: string }
  | { event: "captured"; id: string; origin: string; action: string; file: string; width: number; height: number }
  | { event: "cancelled"; id: string }
  | { event: "error"; id: string; code: string; message: string }
  | { event: "displays"; id: string };

export class CaptureUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureUnavailable";
  }
}

export interface CaptureServiceOptions {
  configDir: string;
  /** Where tunelo-capture writes pictures (inside tunelo's data folder, the user's only). */
  outDir: string;
  /** The shortcut now (config); empty turns it off. */
  hotkey: () => string;
  /** Unset or true: tunelo-capture runs. */
  enabled: () => boolean;
  /** The overlay's language ("vi", "en", "zh-CN"). */
  lang: () => string;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  /** Tests: the process to run instead of spawning the binary. */
  spawnProcess?: (bin: string, args: string[]) => ChildProcess;
}

interface Pending {
  send: (piece: CapturePiece) => void;
  opened: (err?: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CaptureService {
  private child: ChildProcess | undefined;
  private readyHotkey = "";
  private running = false;
  private stopping = false;
  private restartMs = RESTART_MIN_MS;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: CaptureServiceOptions) {}

  /** What MachineInfo.capture says: tunelo-capture runs and its shortcut. */
  info(): { available: boolean; hotkey: string } {
    return { available: this.running, hotkey: this.readyHotkey };
  }

  /** Availability or shortcut changed (devices hear it with the machine's info). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  start(): void {
    this.stopping = false;
    if (this.child || this.opts.enabled() === false) return;
    const bin = locateCapture(this.opts.configDir, this.opts.env, this.opts.execPath);
    if (!bin) return;
    mkdirSync(this.opts.outDir, { recursive: true, mode: 0o700 });
    const args = ["--out", this.opts.outDir, "--lang", this.opts.lang(), "--hotkey", this.opts.hotkey()];
    const child = this.opts.spawnProcess ? this.opts.spawnProcess(bin, args) : spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child = child;
    child.on("error", (err) => this.opts.log(`capture: ${err.message}`));
    child.on("exit", () => this.exited(child));
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => this.line(line));
    }
  }

  private exited(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    const was = this.running;
    this.running = false;
    this.readyHotkey = "";
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.opened(new CaptureUnavailable("the capture process stopped"));
      p.send({ outcome: "failed", message: "the capture process stopped", last: true });
      this.pending.delete(id);
    }
    if (was) this.changed();
    if (this.stopping) return;
    this.opts.log(`capture: tunelo-capture exited, starting again in ${Math.round(this.restartMs / 1000)} s`);
    this.restartTimer = setTimeout(() => this.start(), this.restartMs);
    this.restartTimer.unref?.();
    this.restartMs = Math.min(RESTART_MAX_MS, this.restartMs * 2);
  }

  private write(command: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  private line(line: string): void {
    let event: CaptureEvent;
    try {
      event = JSON.parse(line) as CaptureEvent;
    } catch {
      return;
    }
    switch (event.event) {
      case "ready":
        this.running = true;
        this.readyHotkey = event.hotkey;
        this.restartMs = RESTART_MIN_MS;
        return this.changed();
      case "opened": {
        const p = this.pending.get(event.id);
        if (p) {
          clearTimeout(p.timer);
          p.opened();
        }
        return;
      }
      case "captured":
        return this.deliver(event.id, event.file);
      case "cancelled":
        return this.finish(event.id, { outcome: "cancelled", last: true });
      case "error":
        if (event.code === "hotkey_taken") {
          this.opts.log(`capture: the shortcut could not be registered (${event.message})`);
          this.readyHotkey = "";
          this.changed();
        }
        if (event.id) {
          const p = this.pending.get(event.id);
          clearTimeout(p?.timer);
          p?.opened(new CaptureUnavailable(event.message));
          this.finish(event.id, { outcome: "failed", message: event.message, last: true });
        }
        return;
      default:
        return;
    }
  }

  private finish(id: string, piece: CapturePiece): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.send(piece);
  }

  /** The picture to the device that asked, in pieces; the file is deleted after (a shortcut's stays only on the clipboard). */
  private deliver(id: string, file: string): void {
    const p = this.pending.get(id);
    try {
      if (!p) return;
      this.pending.delete(id);
      const bytes = readFileSync(file);
      const name = file.split(/[\\/]/).pop() ?? "screenshot.png";
      for (let offset = 0; offset < bytes.length || offset === 0; offset += PIECE_BYTES) {
        const data = bytes.subarray(offset, Math.min(bytes.length, offset + PIECE_BYTES));
        p.send({ outcome: "captured", name, mimeType: "image/png", size: bytes.length, offset, data, last: offset + PIECE_BYTES >= bytes.length });
        if (bytes.length === 0) break;
      }
    } catch (err) {
      p?.send({ outcome: "failed", message: err instanceof Error ? err.message : String(err), last: true });
    } finally {
      // Only the user's own Save goes outside the out folder; that copy is theirs.
      if (file.startsWith(this.opts.outDir)) rmSync(file, { force: true });
    }
  }

  /**
   * A device asks for a capture: resolves once the overlay is up, rejects
   * when it cannot open (none, busy, no screen); `send` then gets the picture
   * or the cancel.
   */
  request(id: string, send: (piece: CapturePiece) => void): Promise<void> {
    if (!this.running) return Promise.reject(new CaptureUnavailable("screenshots are not available on this machine"));
    if (this.pending.has(id)) return Promise.reject(new CaptureUnavailable("this capture was already asked for"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CaptureUnavailable("the overlay did not open"));
      }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { send, opened: (err) => (err ? reject(err) : resolve()), timer });
      if (!this.write({ cmd: "capture_interactive", id, origin: "chat" })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CaptureUnavailable("screenshots are not available on this machine"));
      }
    });
  }

  /** The device's link closed: its captures still open are forgotten (their pictures are deleted when they come). */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
  }

  /** The shortcut changed in the config. */
  setHotkey(hotkey: string): void {
    if (this.write({ cmd: "set_hotkey", capture: hotkey })) this.readyHotkey = hotkey;
    this.changed();
  }

  close(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.write({ cmd: "quit" });
    this.child?.stdin?.end();
    const child = this.child;
    if (child) setTimeout(() => child.kill(), 2_000).unref?.();
  }
}
