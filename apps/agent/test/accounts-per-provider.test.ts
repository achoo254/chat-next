// Accounts are kept per AI: the machine's account of one AI moves only that
// AI's sessions, a device names the AI an account request is for (an empty
// name, or one the machine does not know, is refused), and ai-accounts.json,
// the one store of every AI's accounts, is never overwritten once it cannot
// be read.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AccountsStore } from "../src/accounts/store.ts";
import { AgentCore } from "../src/core/agent-core.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, tempDir, until } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const consent = { sensitive: false, projectSettings: false };
const turns = (n: number) => (items: Parameters<typeof byCase>[0]) => byCase(items, "turn").filter((t) => t.body.value.state !== TurnState.RUNNING).length >= n;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("the machine's account of one AI", () => {
  it("moves that AI's idle session and leaves another AI's open session alone", async () => {
    const root = tempDir();
    const work = join(root, "home", "work");
    mkdirSync(work, { recursive: true });
    const alpha = fakeProvider("alpha");
    const beta = fakeProvider("beta");
    const picked: Record<string, string> = { alpha: "" };
    const core = new AgentCore({
      dataDir: join(root, "data"),
      providers: [alpha, beta],
      audit: new AuditLog(join(root, "audit.jsonl")),
      isSensitive: createSensitiveCheck({ home: join(root, "home") }),
      sessionAccount: (provider) => {
        const id = picked[provider] ?? "";
        return id === "" ? { id } : { id, scope: { id, dir: join(root, "ai-accounts", provider, id, "home") } };
      },
      selectedScope: (provider) => {
        const id = picked[provider] ?? "";
        return id === "" ? undefined : { id, dir: join(root, "ai-accounts", provider, id, "home") };
      },
      selectedAccountId: (provider) => picked[provider] ?? "",
    });

    const a = await core.create({ provider: "alpha", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, a.id, turns(1));
    const b = await core.create({ provider: "beta", model: "", dir: work, text: "hello", consent, device: "test" });
    await until(core, b.id, turns(1));
    expect(alpha.log.starts).toHaveLength(1);
    expect(beta.log.starts).toHaveLength(1);

    // The machine picks another alpha account, then tells the core that alpha's account changed.
    picked.alpha = "p2";
    core.followMachineAccount("alpha");
    await settle();

    // alpha's idle session restarted on p2, resumed with the same conversation.
    expect(alpha.log.closed).toBe(1);
    expect(alpha.log.starts).toHaveLength(2);
    expect(alpha.log.starts[1]?.resumeId).toBe("alpha-session-1");
    expect(core.info(a.id)).toMatchObject({ accountId: "p2", machineAccountId: "p2", accountSwitchPending: false });

    // beta's open session was neither closed nor restarted, and still runs on its own account.
    expect(beta.log.closed).toBe(0);
    expect(beta.log.starts).toHaveLength(1);
    expect(core.list().find((t) => t.id === b.id)?.open).toBe(true);
    expect(core.info(b.id)).toMatchObject({ accountId: "", machineAccountId: "", accountSwitchPending: false });
    expect(core.accountStates()).toEqual(
      expect.arrayContaining([
        { threadId: a.id, provider: "alpha", accountId: "p2", switchPending: false },
        { threadId: b.id, provider: "beta", accountId: "", switchPending: false },
      ]),
    );

    await core.send(b.id, "again", "");
    await until(core, b.id, turns(2));
    expect(beta.log.starts).toHaveLength(1);
    expect(beta.log.sent).toContain("again");
    await core.stop();
  });
});

describe("account requests name their AI", () => {
  it("refuses an empty AI name and an unknown one, and an AI with no accounts", async () => {
    const f = profilesFixture();
    const root = tempDir();
    const claude = { ...fakeProvider("claude"), accounts: f.profiles };
    const other = fakeProvider("other");
    const core = new AgentCore({
      dataDir: join(root, "data"),
      providers: [claude, other],
      audit: f.audit,
      isSensitive: createSensitiveCheck({ home: join(root, "home") }),
    });
    const device = await pairedDevice({ core, config: new ConfigStore(join(root, "cfg")), audit: f.audit, providers: [claude, other] });
    const reasonOf = async (provider: string) => {
      const reply = await device.request(`r-${provider}`, { case: "accountSelect", value: { provider, id: "p2" } });
      if (reply.body.case !== "error") throw new Error(`expected a refusal, got ${reply.body.case}`);
      return reply.body.value.reason;
    };
    expect(await reasonOf("")).toBe(ErrorReason.PROVIDER_REQUIRED);
    expect(await reasonOf("../x")).toBe(ErrorReason.UNKNOWN_AI);
    expect(await reasonOf("nope")).toBe(ErrorReason.UNKNOWN_AI);
    expect(await reasonOf("other")).toBe(ErrorReason.NO_ACCOUNTS);
    await core.stop();
  });
});

describe("ai-accounts.json, the one store of every AI's accounts", () => {
  it("is refused for every change once it cannot be read, and is kept as it is", () => {
    const configDir = join(tempDir("accounts-store-"), "tunelo");
    const file = join(configDir, "ai-accounts", "ai-accounts.json");
    const healthy = new AccountsStore(configDir);
    expect(healthy.damaged).toBeNull();
    healthy.update((d) => {
      d.selected["claude"] = "p2";
    });

    writeFileSync(file, "{ not json");
    const broken = new AccountsStore(configDir);
    expect(broken.damaged).toMatch(/damaged/);
    expect(() =>
      broken.update((d) => {
        d.selected["claude"] = "";
      }),
    ).toThrow(/damaged/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(readdirSync(join(configDir, "ai-accounts")).some((n) => n.startsWith("ai-accounts.json.corrupt-"))).toBe(true);
  });
});
