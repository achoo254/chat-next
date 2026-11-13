// Claude profiles driven from a paired device over the end-to-end link, with
// a session journal and the service log in the same config folder: after
// sign-ins with a good code, a wrong one, two codes at once, a cancel, a
// pick, a usage refresh and a removal, no file tunelo owns, no log line and
// no frame the device got (but the sign-in link itself) holds the sign-in
// code, the token claude stored or the link's state. claude's own store,
// ai-accounts/claude/*/home, is left out: that is where claude keeps its
// sign-in. Skipped on Windows only because the fake claude is a script
// (a .cmd cannot run without a shell there).
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { FrameSchema, TurnState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AgentCore } from "../src/core/agent-core.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeProvider } from "./fake-provider.ts";
import { tempDir, until } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { FAKE_TOKEN, FAKE_URL_STATE, GOOD_CODE } from "./support/fake-claude.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const WRONG_CODE = "WRONGCODE-d41d8cd9#leak-check";
const SECRETS = [GOOD_CODE, WRONG_CODE, FAKE_TOKEN, FAKE_URL_STATE];
const ENV = ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_EMAIL", "FAKE_CLAUDE_PID_DIR"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

/** Every file under `dir`, links not followed, `skip` folders left out. */
function files(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...files(path, skip));
    else out.push(path);
  }
  return out;
}

describe.skipIf(process.platform === "win32")("no Claude secret outside claude's own store", () => {
  it("keeps the code, the token and the link's state out of tunelo's files, logs and answers", async () => {
    const printed: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    }
    const configDir = join(tempDir("leak-"), "tunelo");
    mkdirSync(configDir, { recursive: true });
    const f = profilesFixture({ configDir });
    const home = join(f.root, "home");
    mkdirSync(join(home, "work"), { recursive: true });
    // Claude's accounts are the machine's Claude provider; its sessions take the account picked on the machine.
    const claude = { ...fakeProvider("claude"), accounts: f.profiles };
    const core = new AgentCore({
      dataDir: join(configDir, "data"),
      providers: [claude],
      audit: f.audit,
      isSensitive: createSensitiveCheck({ home }),
      sessionAccount: () => f.profiles.sessionAccount(),
      selectedScope: () => f.profiles.selectedScope(),
    });
    const config = new ConfigStore(configDir);
    const device = await pairedDevice({ core, config, audit: f.audit, providers: [claude] });
    let n = 0;
    const ask = (body: Parameters<typeof device.request>[1]) => device.request(String(++n), body);
    const provider = "claude";

    const wrong = await ask({ case: "accountSignInBegin", value: { provider } });
    if (wrong.body.case !== "accountSignInPrompt") throw new Error(`expected a prompt, got ${wrong.body.case}`);
    expect(wrong.body.value.url).toContain(FAKE_URL_STATE);
    expect((await ask({ case: "accountSignInCode", value: { provider, attemptId: wrong.body.value.attemptId, code: WRONG_CODE } })).body).toMatchObject({
      case: "accountSignInResult",
      value: { ok: false, error: "code-rejected" },
    });
    const cancelled = await ask({ case: "accountSignInBegin", value: { provider } });
    if (cancelled.body.case !== "accountSignInPrompt") throw new Error("expected a prompt");
    await ask({ case: "accountSignInCancel", value: { provider, attemptId: cancelled.body.value.attemptId } });

    const kept = await ask({ case: "accountSignInBegin", value: { provider } });
    if (kept.body.case !== "accountSignInPrompt") throw new Error("expected a prompt");
    const attemptId = kept.body.value.attemptId;
    // Two codes at once: one is kept, the other finds the attempt over.
    const [a, b] = await Promise.all([
      ask({ case: "accountSignInCode", value: { provider, attemptId, code: GOOD_CODE } }),
      ask({ case: "accountSignInCode", value: { provider, attemptId, code: GOOD_CODE } }),
    ]);
    const results = [a.body, b.body].map((x) => (x.case === "accountSignInResult" ? x.value.error || "ok" : x.case));
    expect(results.sort()).toEqual(["expired", "ok"]);

    process.env.FAKE_CLAUDE_EMAIL = "third@example.com";
    const third = await ask({ case: "accountSignInBegin", value: { provider } });
    if (third.body.case !== "accountSignInPrompt") throw new Error("expected a prompt");
    const added = await ask({ case: "accountSignInCode", value: { provider, attemptId: third.body.value.attemptId, code: GOOD_CODE } });
    if (added.body.case !== "accountSignInResult" || !added.body.value.ok) throw new Error("third account not added");

    await ask({ case: "accountSelect", value: { provider, id: attemptId } });
    await ask({ case: "usageRefresh", value: { provider, id: attemptId } });
    await ask({ case: "accountRemove", value: { provider, id: added.body.value.id } });
    const list = await ask({ case: "accountList", value: {} });
    expect(list.body.case).toBe("accountListResult");

    // A session in the account, so the journal and state.json exist too.
    const thread = await core.create({ provider, model: "", dir: join(home, "work"), text: "hello", consent: { sensitive: false, projectSettings: false }, device: "phone" });
    await until(core, thread.id, (items) => items.some((i) => i.body.case === "turn" && i.body.value.state !== TurnState.RUNNING));
    await core.stop();
    // What the service printed goes to its log file, as under its supervisor.
    writeFileSync(join(configDir, "tunelo.log"), [...f.logs, ...printed].join("\n"));

    const store = (path: string) => {
      const parts = relative(configDir, path).split(sep);
      return parts[0] === "ai-accounts" && parts[1] === "claude" && parts[3] === "home";
    };
    const owned = files(configDir, store);
    for (const expected of ["ai-accounts.json", "audit.jsonl", "journal.jsonl", "state.json", "config.json", "tunelo.log"]) {
      expect(owned.some((p) => p.endsWith(expected)), expected).toBe(true);
    }
    for (const path of owned) {
      const text = readFileSync(path, "utf8");
      for (const secret of SECRETS) expect(text.includes(secret), `${secret} in ${path}`).toBe(false);
    }
    // Only the sign-in links carry the link's state to the device; nothing carries a code or a token.
    for (const frame of device.received) {
      const bytes = Buffer.from(toBinary(FrameSchema, frame)).toString("latin1");
      for (const secret of [GOOD_CODE, WRONG_CODE, FAKE_TOKEN]) expect(bytes.includes(secret), `${secret} in a ${frame.body.case} frame`).toBe(false);
      if (frame.body.case !== "accountSignInPrompt") expect(bytes.includes(FAKE_URL_STATE), `link state in a ${frame.body.case} frame`).toBe(false);
    }
    // The check would see it: claude itself did store the token, in its own folder.
    expect(readFileSync(join(configDir, "ai-accounts", "claude", attemptId, "home", ".credentials.json"), "utf8")).toContain(FAKE_TOKEN);
  });
});
