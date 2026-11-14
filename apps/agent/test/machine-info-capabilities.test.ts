// What a machine says of each AI: the capabilities devices read come from
// the adapter's facets, so an AI that keeps several accounts says so (the
// "Tài khoản AI" screen shows a block only for those), and one without them
// does not.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { Machine } from "../src/machine.ts";
import { fakeProvider } from "./fake-provider.ts";
import { profilesFixture } from "./support/profiles-fixture.ts";

let dir = "";
let machine: Machine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunelo-info-"));
  const withAccounts = { ...fakeProvider("claude"), accounts: profilesFixture().profiles };
  machine = new Machine({ config: new ConfigStore(dir), providers: [withAccounts, fakeProvider("other")], log: () => undefined });
});

afterEach(async () => {
  await machine.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the machine's AIs", () => {
  test("an AI with an accounts facet says it keeps accounts; one without says it does not", async () => {
    const info = await machine.machineInfo();
    const accounts = Object.fromEntries(info.providers.map((p) => [p.id, p.capabilities?.accounts]));
    expect(accounts).toEqual({ claude: true, other: false });
  });
});
