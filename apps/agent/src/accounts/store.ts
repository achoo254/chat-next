// ai-accounts.json: the saved accounts of every AI on this machine (who each
// is signed in as) and which one each AI's new sessions use. Only the service
// writes it, through a temp file and a rename; one store serves every AI, so
// one process holds one instance. No credential is ever in it: what an AI
// needs beyond the shared fields sits in `providerData`, the adapter's to
// shape and check. A file that cannot be read is never taken for "no
// accounts": a copy is kept, the file stays as it is, and the store refuses
// every change until someone repairs it, so nothing gets signed out or
// deleted on its account.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ACCOUNT_ID_RE, PROVIDER_ID_RE, accountsRoot } from "./paths.ts";

const providerData = z.record(z.string(), z.unknown()).default({});

const accountSchema = z.object({
  provider: z.string().regex(PROVIDER_ID_RE),
  id: z.string().regex(ACCOUNT_ID_RE),
  label: z.string().default(""),
  email: z.string().default(""),
  organization: z.string().default(""),
  plan: z.string().default(""),
  createdAt: z.number(),
  providerData,
});

/** What tunelo last saw of an AI's own sign-in on the machine (id ""). */
const ownSchema = z.object({
  email: z.string().default(""),
  organization: z.string().default(""),
  plan: z.string().default(""),
  providerData,
});

const fileSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(accountSchema).default([]),
  /** The picked account of each AI; missing or "": its own sign-in. */
  selected: z.record(z.string(), z.string()).default({}),
  own: z.record(z.string(), ownSchema).default({}),
});

export type StoredAccount = z.infer<typeof accountSchema>;
export type OwnSignIn = z.infer<typeof ownSchema>;
export type AccountsFile = z.infer<typeof fileSchema>;

export class AccountsStore {
  readonly file: string;
  private data: AccountsFile;
  /** Why ai-accounts.json could not be read; null when it is fine (or not there yet). */
  readonly damaged: string | null = null;

  constructor(configDir: string, now: () => number = Date.now) {
    const root = accountsRoot(configDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "ai-accounts.json");
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

  get(): Readonly<AccountsFile> {
    return this.data;
  }

  update(change: (d: AccountsFile) => void): void {
    if (this.damaged) throw new Error(this.damaged);
    const next = structuredClone(this.data);
    change(next);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
  }
}
