// profiles.json: the Claude profiles of this machine (who each is signed in
// as, last plan usage) and which one new sessions use. Only the service
// writes it, through a temp file and a rename. No credential is ever in it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PROFILE_ID_RE, profilesRoot } from "./paths.ts";

const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });
const usageSchema = z.object({
  fiveHour: windowSchema.optional(),
  sevenDay: windowSchema.optional(),
  updatedAt: z.number(),
});

const profileSchema = z.object({
  id: z.string().regex(PROFILE_ID_RE),
  email: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  plan: z.string().default(""),
  createdAt: z.number(),
  lastUsage: usageSchema.optional(),
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
export type StoredProfile = z.infer<typeof profileSchema>;
export type ProfilesFile = z.infer<typeof fileSchema>;

export class ProfileStore {
  readonly file: string;
  private data: ProfilesFile;

  constructor(configDir: string) {
    const root = profilesRoot(configDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "profiles.json");
    this.data = ProfileStore.load(this.file);
  }

  private static load(file: string): ProfilesFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // first start, or unreadable: start empty rather than fail the service
    }
    return fileSchema.parse({});
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
    const next = structuredClone(this.data);
    change(next);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
  }
}
