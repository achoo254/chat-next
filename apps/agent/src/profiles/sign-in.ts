// Signing a new profile in to Claude from a device: `claude auth login
// --claudeai` runs with no terminal, its sign-in link goes to the device
// (end to end encrypted), and the code the page shows comes back the same
// way, straight into claude's stdin. The code lives only in memory for that
// write: it is never stored, logged or put in an error. claude's own output
// is never logged either (it carries the link with its state).
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { claudeEnv } from "./account.ts";

/** How long claude has to print its link before tunelo gives up on remote sign-in. */
const URL_TIMEOUT_MS = 20_000;
/** How long claude has to check the code and exit. */
const CODE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;

/**
 * Keeps claude from opening a browser on the machine itself (nobody is
 * there): claude runs $BROWSER with the link instead. On Windows `where`
 * only prints an error for a link and exits; no window opens.
 */
export function noBrowser(): string {
  if (process.platform === "win32") return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\where.exe`;
  return "/usr/bin/true";
}

// OSC 8 hyperlinks (ESC ] 8 ; params ; uri ST) and CSI sequences around the
// link: matching terminal control characters is the point of these patterns.
/* eslint-disable no-control-regex */
const OSC = /\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const URL_RE = /https:\/\/[^\s"'<>\u0007\u001b]+/g;
/* eslint-enable no-control-regex */

/** The first claude sign-in link (https, claude.ai or claude.com, code=true) in claude's output. */
export function extractSignInUrl(output: string): string | null {
  const text = output.replace(OSC, " ").replace(CSI, "");
  for (const raw of text.match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const host = url.hostname;
    const claudeHost = ["claude.ai", "claude.com"].some((h) => host === h || host.endsWith(`.${h}`));
    if (url.protocol === "https:" && claudeHost && url.searchParams.get("code") === "true") return url.toString();
  }
  return null;
}

/** A code as the sign-in page shows it: printable, no spaces. */
export function validCode(code: string): boolean {
  return code.length >= 8 && code.length <= 1024 && /^[\x21-\x7e]+$/.test(code);
}

export type LoginProcess = {
  url: string;
  /** Writes the code to claude and waits for it to finish: its exit code (-1 when it had to be stopped). */
  submit(code: string): Promise<number>;
  kill(): void;
};

/**
 * Starts `claude auth login --claudeai` for `configDir` and waits for its
 * link. Rejects when claude exits or prints no link in time: remote sign-in
 * does not work with this claude, and the user signs in on the machine.
 */
export function startLogin(bin: string, configDir: string, urlTimeoutMs = URL_TIMEOUT_MS): Promise<LoginProcess> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ["auth", "login", "--claudeai"], {
      env: claudeEnv(configDir, { BROWSER: noBrowser() }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  let output = "";
  let exited: number | null = null;
  const exitWaiters: ((code: number) => void)[] = [];
  const onData = (chunk: Buffer) => {
    if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, signal) => {
    exited = code ?? (signal ? -1 : 1);
    for (const w of exitWaiters.splice(0)) w(exited);
  });
  const waitExit = (): Promise<number> => (exited !== null ? Promise.resolve(exited) : new Promise((r) => exitWaiters.push(r)));
  const kill = () => {
    if (exited === null) child.kill();
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      kill();
      reject(new Error("claude printed no sign-in link"));
    }, urlTimeoutMs);
    const check = () => {
      const url = extractSignInUrl(output);
      if (!url) return;
      done();
      resolve({
        url,
        kill,
        async submit(code) {
          if (exited !== null) return exited;
          child.stdin.write(`${code}\n`);
          const stop = setTimeout(kill, CODE_TIMEOUT_MS);
          const result = await waitExit();
          clearTimeout(stop);
          return result;
        },
      });
    };
    const onExit = () => {
      done();
      reject(new Error("claude ended before showing a sign-in link"));
    };
    const onError = (err: Error) => {
      done();
      reject(err);
    };
    function done() {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
