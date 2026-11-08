// profiles.json: the Claude profiles of this machine (who each is signed in
// as, last plan usage) and which one new sessions use. Only the service
// writes it, through a temp file and a rename. No credential is ever in it.
// A file that cannot be read is never taken for "no profiles": a copy is
// kept, the file stays as it is, and the store refuses every change until
// someone repairs it, so nothing gets signed out or deleted on its account.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PROFILE_ID_RE, profilesRoot } from "./paths.ts";

const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });
const usageSchema = z.object({
  fiveHour: windowSchema.optional(),
  sevenDay: windowSchema.optional(),
  updatedAt: z.number(),
});

/** The last `claude auth status` of a profile. */
const signInSchema = z.object({ loggedIn: z.boolean(), loginExpiresAt: z.number(), checkedAt: z.number() });

const profileSchema = z.object({
  id: z.string().regex(PROFILE_ID_RE),
  email: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  plan: z.string().default(""),
  createdAt: z.number(),
  lastUsage: usageSchema.optional(),
  signIn: signInSchema.optional(),
});

const fileSchema = z.object({
  selectedProfileId: z.string().nullable().default(null),
  profiles: z.array(profileSchema).default([]),
  /** The default profile's last account report and usage, for the list. */
  defaultProfile: z
    .object({ email: z.string(), orgId: z.string(), orgName: z.string(), plan: z.string(), lastUsage: usageSchema.optional() })
    .partial()
    .default({}),
});

export type ProfileUsage = z.infer<typeof usageSchema>;
export type ProfileSignIn = z.infer<typeof signInSchema>;
export type StoredProfile = z.infer<typeof profileSchema>;
export type ProfilesFile = z.infer<typeof fileSchema>;

export class ProfileStore {
  readonly file: string;
  private data: ProfilesFile;
  /** Why profiles.json could not be read; null when it is fine (or not there yet). */
  readonly damaged: string | null = null;

  constructor(configDir: string, now: () => number = Date.now) {
    const root = profilesRoot(configDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "profiles.json");
    this.data = fileSchema.parse({});
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.damaged = `${this.file} could not be read (${(err as Error).message})`;
      return;
    }
    let parsed: ReturnType<typeof fileSchema.safeParse> | undefined;
    try {
      parsed = fileSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) {
      this.data = parsed.data;
      return;
    }
    const copy = `${this.file}.corrupt-${now()}`;
    try {
      copyFileSync(this.file, copy);
    } catch {
      // the original stays in place either way
    }
    this.damaged = `${this.file} is damaged (a copy is in ${copy}); repair or remove it, then restart tunelo`;
  }

  get(): Readonly<ProfilesFile> {
    return this.data;
  }

  find(id: string): StoredProfile | undefined {
    return this.data.profiles.find((p) => p.id === id);
  }

  /** The profile new sessions use; null for the default one (also when the selected one is gone). */
  selected(): StoredProfile | null {
    const id = this.data.selectedProfileId;
    return id === null ? null : (this.find(id) ?? null);
  }

  update(change: (d: ProfilesFile) => void): void {
    if (this.damaged) throw new Error(this.damaged);
    const next = structuredClone(this.data);
    change(next);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
  }
}
