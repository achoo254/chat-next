// Claude's part of ai-accounts.json (accounts/store.ts): its saved accounts
// (who each is signed in as, last plan usage, last `claude auth status`), the
// machine's own Claude sign-in, and which one new sessions use. The shared
// fields hold what every AI has; Claude's own (organization id, usage, sign-in
// check) sit in providerData and are checked here. No credential is ever kept.
import { z } from "zod";
import type { AccountsFile, AccountsStore, StoredAccount } from "../../../accounts/store.ts";
import { CLAUDE_PROVIDER_ID } from "./paths.ts";

const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });
const usageSchema = z.object({
  fiveHour: windowSchema.optional(),
  sevenDay: windowSchema.optional(),
  updatedAt: z.number(),
});

/** The last `claude auth status` of a profile. */
const signInSchema = z.object({ loggedIn: z.boolean(), loginExpiresAt: z.number(), checkedAt: z.number() });

const savedDataSchema = z.object({ orgId: z.string().default(""), lastUsage: usageSchema.optional(), signIn: signInSchema.optional() });
const ownDataSchema = z.object({ orgId: z.string().optional(), lastUsage: usageSchema.optional() });

export type ProfileUsage = z.infer<typeof usageSchema>;
export type ProfileSignIn = z.infer<typeof signInSchema>;

export type StoredProfile = {
  id: string;
  email: string;
  orgId: string;
  orgName: string;
  plan: string;
  createdAt: number;
  lastUsage?: ProfileUsage;
  signIn?: ProfileSignIn;
};

export type ProfilesFile = {
  selectedProfileId: string | null;
  profiles: StoredProfile[];
  /** The machine's own sign-in: its last account report and usage, for the list. */
  defaultProfile: { email?: string; orgId?: string; orgName?: string; plan?: string; lastUsage?: ProfileUsage };
};

function toProfile(a: StoredAccount): StoredProfile {
  const data = savedDataSchema.safeParse(a.providerData);
  const extra = data.success ? data.data : { orgId: "" };
  return {
    id: a.id,
    email: a.email,
    orgId: extra.orgId,
    orgName: a.organization,
    plan: a.plan,
    createdAt: a.createdAt,
    ...(extra.lastUsage ? { lastUsage: extra.lastUsage } : {}),
    ...(extra.signIn ? { signIn: extra.signIn } : {}),
  };
}

function fromProfile(p: StoredProfile): StoredAccount {
  return {
    provider: CLAUDE_PROVIDER_ID,
    id: p.id,
    label: "",
    email: p.email,
    organization: p.orgName,
    plan: p.plan,
    createdAt: p.createdAt,
    providerData: { orgId: p.orgId, ...(p.lastUsage ? { lastUsage: p.lastUsage } : {}), ...(p.signIn ? { signIn: p.signIn } : {}) },
  };
}

function toFile(d: Readonly<AccountsFile>): ProfilesFile {
  const own = d.own[CLAUDE_PROVIDER_ID];
  const ownData = ownDataSchema.safeParse(own?.providerData ?? {});
  const extra = ownData.success ? ownData.data : {};
  const selected = d.selected[CLAUDE_PROVIDER_ID] ?? "";
  return {
    selectedProfileId: selected === "" ? null : selected,
    profiles: d.accounts.filter((a) => a.provider === CLAUDE_PROVIDER_ID).map(toProfile),
    defaultProfile: own
      ? {
          ...(own.email ? { email: own.email } : {}),
          ...(own.organization ? { orgName: own.organization } : {}),
          ...(own.plan ? { plan: own.plan } : {}),
          ...(extra.orgId !== undefined ? { orgId: extra.orgId } : {}),
          ...(extra.lastUsage ? { lastUsage: extra.lastUsage } : {}),
        }
      : {},
  };
}

/** Claude's accounts in the shared store, in the shape the Claude account service works with. */
export class ProfileStore {
  constructor(private readonly store: AccountsStore) {}

  /** Why the shared store could not be read; null when it is fine. */
  get damaged(): string | null {
    return this.store.damaged;
  }

  get(): Readonly<ProfilesFile> {
    return toFile(this.store.get());
  }

  find(id: string): StoredProfile | undefined {
    return this.get().profiles.find((p) => p.id === id);
  }

  /** The profile new sessions use; null for the default one (also when the selected one is gone). */
  selected(): StoredProfile | null {
    const id = this.get().selectedProfileId;
    return id === null ? null : (this.find(id) ?? null);
  }

  update(change: (d: ProfilesFile) => void): void {
    this.store.update((d) => {
      const next = toFile(d);
      change(next);
      d.accounts = [...d.accounts.filter((a) => a.provider !== CLAUDE_PROVIDER_ID), ...next.profiles.map(fromProfile)];
      d.selected[CLAUDE_PROVIDER_ID] = next.selectedProfileId ?? "";
      const own = next.defaultProfile;
      d.own[CLAUDE_PROVIDER_ID] = {
        email: own.email ?? "",
        organization: own.orgName ?? "",
        plan: own.plan ?? "",
        providerData: { ...(own.orgId !== undefined ? { orgId: own.orgId } : {}), ...(own.lastUsage ? { lastUsage: own.lastUsage } : {}) },
      };
    });
  }
}
