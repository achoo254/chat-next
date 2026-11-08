// The machine links itself to Localman after `tunelo login`: the tunnel
// server mints a link token, Localman gets it, tunelo keeps no copy (not in
// its config, not in its log). Localman failing only sets Localman's state
// and tries again with backoff; a linked machine is not linked again on
// restart, but is after `tunelo login`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfLinkError, type SelfLinkOptions } from "@tunelo/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { type AppName, ResourceNotGrantedError, type SessionInfo } from "../src/identity/session.ts";
import { LocalmanLink, machineNameFor } from "../src/localman/self-link.ts";
import { type AppSession, RETRY_FIRST_MS, Registration } from "../src/registration-status.ts";

const LINK_TOKEN = "tunelo_link_secret_0123456789";
const AGENT: SessionInfo = { issuer: "https://auth.example", sub: "acc_1", clientId: "tunelo-agent" };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-localman-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(info: SessionInfo | undefined, covers: (app: AppName) => boolean = () => true): AppSession {
  return {
    info: () => info,
    covers: (app) => info !== undefined && covers(app),
    getAppToken: async (app) => {
      if (!covers(app)) throw new ResourceNotGrantedError(app);
      return `access-${app}`;
    },
  };
}

type Posted = { url: string; auth: string; body: Record<string, unknown> };

function setup(opts: { info?: SessionInfo | undefined; covers?: (app: AppName) => boolean; localman?: (n: number) => Response; link?: (o: SelfLinkOptions) => Promise<unknown> } = {}) {
  const config = new ConfigStore(dir);
  config.update((c) => {
    c.machineId = "42";
    c.machineName = "Mac\u0007 mini";
  });
  const posted: Posted[] = [];
  const linked: SelfLinkOptions[] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let now = 1_000_000;
  const fetchFn = vi.fn(async (url: URL | string | Request, init?: RequestInit) => {
    posted.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "", body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return opts.localman ? opts.localman(posted.length) : new Response(JSON.stringify({ link: { id: "l1" } }), { status: 200 });
  });
  const link = new LocalmanLink({
    config,
    session: session("info" in opts ? opts.info : AGENT, opts.covers),
    tunnelServer: "https://tunnel.example",
    localmanOrigin: () => "https://localman.example",
    link: (async (o: SelfLinkOptions) => {
      linked.push(o);
      if (opts.link) await opts.link(o);
      return { token: LINK_TOKEN, linkId: "lnk_1", forwardUrl: "https://m-x.tunnel.example/.tunelo/forward" };
    }) as never,
    fetch: fetchFn as unknown as typeof fetch,
    forward: () => ({ enabled: true, available: true, blockedPorts: [] }),
    log: (l) => logs.push(l),
    now: () => now,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const fire = async () => {
    const t = timers.filter((x) => !x.cancelled).at(-1);
    if (!t) throw new Error("no retry pending");
    t.cancelled = true;
    now += t.ms;
    t.fn();
    await settle();
  };
  return { config, link, posted, linked, logs, timers, settle, fire };
}

describe("linking the machine to Localman", () => {
  test("hands the tunnel server's link token to Localman with the machine's id and name, and keeps no copy", async () => {
    const s = setup();
    s.link.start();
    await s.settle();
    expect(s.linked).toEqual([expect.objectContaining({ serverUrl: "https://tunnel.example", accessToken: "access-tunnel", deviceId: "chat-agent.42", clientName: "Localman" })]);
    expect(s.posted).toEqual([
      { url: "https://localman.example/tunelo/links/self", auth: "Bearer access-localman", body: { token: LINK_TOKEN, machineId: "42", machineName: "Mac mini" } },
    ]);
    expect(s.link.state()).toEqual({ status: "ok", detail: "linked; localhost forwarding on" });
    expect(s.config.get().localman).toEqual({ sub: "acc_1", deviceId: "chat-agent.42", linkedAt: 1_000_000 });
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(LINK_TOKEN);
    expect(s.logs.join("\n")).not.toContain(LINK_TOKEN);
  });

  test("a machine linked for this account is not linked again on restart; `tunelo login` links it anew", async () => {
    const s = setup();
    s.link.start();
    await s.settle();
    const again = new LocalmanLink({
      config: s.config,
      session: session(AGENT),
      tunnelServer: "https://tunnel.example",
      link: (async () => {
        throw new Error("must not link");
      }) as never,
      log: () => undefined,
    });
    again.start();
    await s.settle();
    expect(again.state().status).toBe("ok");
    s.link.retryNow();
    await s.settle();
    expect(s.linked).toHaveLength(2);
    expect(s.posted).toHaveLength(2);
  });

  test("another account signed in links again", async () => {
    const s = setup();
    s.config.update((c) => (c.localman = { sub: "acc_other", deviceId: "chat-agent.42", linkedAt: 1 }));
    s.link.start();
    await s.settle();
    expect(s.posted).toHaveLength(1);
    expect(s.config.get().localman?.sub).toBe("acc_1");
  });

  test("Localman full: an error with the reason, retried with backoff, never touching the token", async () => {
    const s = setup({ localman: (n) => (n === 1 ? Response.json({ error: { code: "TUNNEL_LINK_LIMIT_REACHED", message: "x" } }, { status: 409 }) : Response.json({}, { status: 200 })) });
    s.link.start();
    await s.settle();
    const failed = s.link.state();
    expect(failed.status).toBe("error");
    expect(failed.detail).toMatch(/20 machines/);
    expect(failed.retryAt).toBe(1_000_000 + RETRY_FIRST_MS);
    expect(s.config.get().localman).toBeUndefined();
    await s.fire();
    expect(s.link.state().status).toBe("ok");
    expect(s.logs.join("\n")).not.toContain(LINK_TOKEN);
  });

  test("Localman down or unreachable: waiting, the backoff doubles", async () => {
    const s = setup({ localman: () => new Response("", { status: 503 }) });
    s.link.start();
    await s.settle();
    expect(s.link.state().status).toBe("waiting");
    await s.fire();
    expect(s.timers.at(-1)?.ms).toBe(2 * RETRY_FIRST_MS);
  });

  test("a sign-in Localman refuses asks for tunelo login; a tunnel server without self links waits", async () => {
    const s = setup({ localman: () => new Response("", { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope"' } }) });
    s.link.start();
    await s.settle();
    expect(s.link.state()).toEqual(expect.objectContaining({ status: "sign-in" }));
    const t = setup({
      link: async () => {
        throw new SelfLinkError(404, null);
      },
    });
    t.link.start();
    await t.settle();
    expect(t.link.state()).toEqual(expect.objectContaining({ status: "waiting", detail: "the tunnel server does not link machines to apps yet" }));
    expect(t.posted).toEqual([]);
  });

  test("a sign-in without Localman, or no sign-in, or no machine yet: nothing is called", async () => {
    const a = setup({ covers: (app) => app !== "localman" });
    a.link.start();
    await a.settle();
    expect(a.link.state().status).toBe("sign-in");
    const b = setup({ info: undefined });
    b.link.start();
    await b.settle();
    expect(b.link.state().status).toBe("sign-in");
    const c = setup();
    c.config.update((x) => delete x.machineId);
    c.link.start();
    await c.settle();
    expect(c.link.state().status).toBe("waiting");
    expect([...a.linked, ...b.linked, ...c.linked]).toEqual([]);
  });

  test("machine names are cleaned for Localman", () => {
    expect(machineNameFor("  \u0000  ")).toBe("machine");
    expect(machineNameFor("x".repeat(300))).toHaveLength(100);
  });
});

describe("in tunelo whoami", () => {
  test("the registration reports Localman's state and `tunelo login` relinks it too", () => {
    const config = new ConfigStore(dir);
    const localman = { state: () => ({ status: "error" as const, detail: "Localman refused" }), retryNow: vi.fn() };
    const registration = new Registration({
      config,
      session: session(AGENT),
      api: { register: async () => ({ machineId: "1", machineSecret: "s" }), claim: async () => ({}) },
      publicKey: () => new Uint8Array(32),
      agentVersion: "2.1.0",
      onRegistered: () => undefined,
      localman,
      log: () => undefined,
      schedule: () => () => undefined,
    });
    expect(registration.report().localman).toEqual({ status: "error", detail: "Localman refused" });
    registration.retryNow();
    registration.stop();
    expect(localman.retryNow).toHaveBeenCalledOnce();
  });
});
