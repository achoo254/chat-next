// The machine's Claude account seen from devices: picking one (from a device
// or from the machine's own terminal) reaches every connected device as
// MachineAccounts, then again when each session has moved and when the new
// account's usage is read. And the account offered when a session runs out:
// the signed-in one with the most usage left.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type MachineAccounts, TurnState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { Machine } from "../src/machine.ts";
import { makeProfileHome } from "../src/providers/claude/accounts/paths.ts";
import { usageLeft } from "../src/providers/claude/accounts/service.ts";
import { setupProfileHome } from "../src/providers/claude/accounts/setup.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, until } from "./harness.ts";
import { signInDefault } from "./support/fake-claude.ts";
import { type Device, connectDevice, waitFor } from "./support/machine-device.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

type Fixture = ReturnType<typeof profilesFixture>;

/** Adds a signed-in account to the store, as a finished sign-in leaves it. */
function addProfile(f: Fixture, id: string, email: string): void {
  const home = makeProfileHome(f.configDir, id, f.claudeHome);
  setupProfileHome(home, f.claudeHome);
  signInDefault(home, email);
  f.profiles.store.update((d) => {
    d.profiles.push({ id, email, orgId: "org-1", orgName: "Org One", plan: "max", createdAt: 1, signIn: { loggedIn: true, loginExpiresAt: 0, checkedAt: Date.now() } });
  });
}

/** Every MachineAccounts announcement a device heard, in order. */
const announced = (d: Device): MachineAccounts[] => d.frames.flatMap((f) => (f.body.case === "machineAccounts" && f.id === "" ? [f.body.value] : []));

describe("the machine's Claude account on every device", () => {
  it("announces a pick from a device or from the machine to every device, then each session moved and the new usage", async () => {
    const f = profilesFixture({ defaultEmail: "team@example.com" });
    addProfile(f, "p2", "max@example.com");
    await f.profiles.list();
    const home = join(f.root, "home");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const claude = { ...fakeProvider("claude"), accounts: f.profiles };
    const machine = new Machine({ config: new ConfigStore(f.configDir), providers: [claude], log: () => undefined });
    const port = await machine.start(0);
    cleanup.push(() => machine.stop());
    const phone = await connectDevice(machine, port, "phone");
    const laptop = await connectDevice(machine, port, "laptop");
    cleanup.push(() => phone.close(), () => laptop.close());

    const t = await machine.core.create({ provider: "claude", model: "", dir: work, text: "hello", consent: { sensitive: false, projectSettings: false }, device: "test" });
    await until(machine.core, t.id, (items) => byCase(items, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));

    // From the phone: both devices hear the pick, the session on p2 and p2's fresh usage.
    phone.request("pick", { case: "accountSelect", value: { provider: "claude", id: "p2" } });
    for (const d of [phone, laptop]) {
      await waitFor(() =>
        announced(d).some(
          (m) =>
            m.accounts?.selectedByProvider["claude"] === "p2" &&
            m.sessions.some((s) => s.threadId === t.id && s.provider === "claude" && s.accountId === "p2" && !s.switchPending) &&
            m.accounts?.accounts.find((a) => a.provider === "claude" && a.id === "p2")?.usage?.fiveHour?.utilization === 12,
        ),
      );
    }
    // The answer to the pick may come after the announcements: wait for it.
    await waitFor(() => phone.frames.some((x) => x.id === "pick" && x.body.case === "accountListResult"));
    expect(laptop.frames.some((x) => x.id === "pick")).toBe(false);
    const last = announced(laptop).at(-1);
    expect(last?.accounts?.accounts.filter((a) => a.provider === "claude").map((a) => a.email)).toEqual(["team@example.com", "max@example.com"]);
    expect(machine.core.list()[0]?.open).toBe(true);
    expect(f.probed).toContain(join(f.configDir, "ai-accounts", "claude", "p2", "home"));

    // From the machine's own terminal: the same, back to the default account.
    await f.profiles.select("", "local");
    for (const d of [phone, laptop]) {
      await waitFor(
        () => announced(d).at(-1)?.accounts?.selectedByProvider["claude"] === "" && announced(d).at(-1)?.sessions.every((s) => s.accountId === "") === true,
      );
    }
  });
});

describe("the account offered when a session runs out", () => {
  it("is the signed-in account with the most usage left, read again first", async () => {
    const now = Date.now();
    const usage: Record<string, number> = { default: 97, p2: 30, p3: 10 };
    const f = profilesFixture({
      defaultEmail: "team@example.com",
      probe: async (_bin, dir) => {
        const id = dir === undefined ? "default" : (dir.split("/").at(-2) ?? "");
        return { fiveHour: { utilization: usage[id] ?? 0, resetsAt: now + 3_600_000 }, sevenDay: { utilization: 20, resetsAt: now + 86_400_000 } };
      },
    });
    addProfile(f, "p2", "max@example.com");
    addProfile(f, "p3", "gone@example.com");
    // p3 signed out since it was added: claude says so when its usage is read.
    rmSync(join(f.configDir, "ai-accounts", "claude", "p3", "home", "fake-auth.json"));
    await f.profiles.list();

    expect(await f.profiles.suggestion("")).toEqual({ id: "p2", email: "max@example.com", remaining: 70 });
    expect(f.profiles.view().accounts.find((a) => a.id === "p3")?.status).toBe("needs-sign-in");

    // On p2 and out: the default has 3% left.
    usage.p2 = 100;
    expect(await f.profiles.suggestion("p2")).toEqual({ id: "", email: "team@example.com", remaining: 3 });

    // Nobody has room.
    usage.default = 100;
    const g = profilesFixture({ defaultEmail: "solo@example.com", probe: async () => ({ fiveHour: { utilization: 100, resetsAt: now + 1000 } }) });
    addProfile(g, "p9", "full@example.com");
    await g.profiles.list();
    expect(await g.profiles.suggestion("")).toBeUndefined();
  });

  it("counts a window past its reset as unused, and the tighter window as what is left", () => {
    const now = 1_000_000;
    expect(usageLeft({ fiveHour: { utilization: 90, resetsAt: now - 1 }, sevenDay: { utilization: 40, resetsAt: now + 1 } }, now)).toBe(60);
    expect(usageLeft({ fiveHour: { utilization: 25, resetsAt: 0 } }, now)).toBe(75);
    expect(usageLeft({}, now)).toBe(100);
    expect(usageLeft({ sevenDay: { utilization: 120, resetsAt: now + 1 } }, now)).toBe(0);
  });
});
