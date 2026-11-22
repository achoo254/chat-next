// Reading the fields of a filtered record the way the normalizer needs them:
// every field optional, each of an expected type. A field missing is simply
// absent; a field of another type is treated as missing and its name noted,
// so a change of format in Claude Code is counted and logged instead of
// thrown or stored wrong. Field names the normalizer does not know are
// noted too (record-known-fields.ts).

/** The value types a filtered record's field can have (privacy/filtered-record.ts). */
export type FieldValue = string | number | boolean | readonly string[];

export class RecordFields {
  /** Fields present with a type the normalizer did not expect. */
  readonly mistyped: string[] = [];

  constructor(private readonly f: Readonly<Record<string, FieldValue>>) {}

  /** A non-empty string field. */
  text(key: string): string | undefined {
    const v = this.f[key];
    if (v === undefined) return undefined;
    if (typeof v === "string" && v !== "") return v;
    this.mistyped.push(key);
    return undefined;
  }

  /** A finite number field; `whole` also asks for a non-negative integer (a count, bytes, milliseconds). */
  number(key: string, whole = true): number | undefined {
    const v = this.f[key];
    if (v === undefined) return undefined;
    if (typeof v === "number" && Number.isFinite(v) && (!whole || (Number.isSafeInteger(v) && v >= 0))) return v;
    this.mistyped.push(key);
    return undefined;
  }

  flag(key: string): boolean | undefined {
    const v = this.f[key];
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    this.mistyped.push(key);
    return undefined;
  }

  /** The names present in the record that `known` does not list. */
  unknown(known: ReadonlySet<string>): string[] {
    return Object.keys(this.f).filter((k) => !known.has(k));
  }
}
