// What a call cost at its AI's API prices (an estimate: a subscription plan
// is not charged it), from the model catalog the AI's usage source gives
// (UsageSource.models). The ledger never stores a cost: it is worked out when
// a report or a rule needs it, so a corrected price applies to old calls too.
import type { ModelCatalog, ModelPrice } from "../providers/types.ts";
import type { Turn } from "./ledger.ts";

/** The model catalog of an AI by its provider id; undefined when it has none. */
export type Catalogs = (provider: string) => ModelCatalog | undefined;

export const noCatalogs: Catalogs = () => undefined;

/** Dollars of `tokens` at `price` (per million). */
export function costAt(t: Pick<Turn, "input" | "output" | "cacheRead" | "cacheWrite">, price: ModelPrice): number {
  return (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1e6;
}

/** The call's cost; undefined when its model's price is not known. */
export function costOf(t: Turn, catalogs: Catalogs): number | undefined {
  const price = catalogs(t.provider)?.price(t.model);
  return price ? costAt(t, price) : undefined;
}
