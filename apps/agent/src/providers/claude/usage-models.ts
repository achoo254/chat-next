// Claude's models for the usage ledger: API prices per million tokens, how
// strong each model is, and Claude Code's tools that only read, search or run
// a command. Prices are an estimate (a subscription plan is not charged them).
// The 5.5 rows match the cost Claude Code reports for its own calls on a
// machine (OpenTelemetry cost_usd, 26/11/2026) to the cent. The ledger keeps a
// call's cache writes as one number, while Claude prices a 5-minute write at
// 1.25 × input and a 1-hour one at 2 × input; a write is counted at 1.6 ×
// input, about the mix Claude Code makes. Fable's price is not known: its calls
// are counted without a cost.
import type { ModelCatalog, ModelPrice, ModelTier } from "../types.ts";

type Row = { match: RegExp; tier: ModelTier; price?: ModelPrice; lighter?: ModelPrice };

const price = (input: number, output: number, cacheRead: number): ModelPrice => ({ input, output, cacheRead, cacheWrite: +(input * 1.6).toFixed(4) });

const SONNET_5 = price(2, 10, 0.1);
const SONNET_4 = price(3, 15, 0.3);

/** First match wins: newer generations before the family's catch-all. */
const ROWS: readonly Row[] = [
  { match: /^claude-fable-/, tier: "strong", lighter: SONNET_5 },
  { match: /^claude-opus-5-/, tier: "strong", price: price(4, 20, 0.2), lighter: SONNET_5 },
  { match: /^claude-opus-4-[5-9]/, tier: "strong", price: price(5, 25, 0.5), lighter: SONNET_4 },
  { match: /^claude-opus-/, tier: "strong", price: price(15, 75, 1.5), lighter: SONNET_4 },
  { match: /^claude-sonnet-5-/, tier: "standard", price: SONNET_5 },
  { match: /^claude-sonnet-/, tier: "standard", price: SONNET_4 },
  { match: /^claude-haiku-5-/, tier: "light", price: price(1, 5, 0.05) },
  { match: /^claude-haiku-/, tier: "light", price: price(1, 5, 0.1) },
];

const rowOf = (model: string): Row | undefined => {
  const id = model.toLowerCase();
  return ROWS.find((r) => r.match.test(id));
};

export const claudeModels: ModelCatalog = {
  price: (model) => rowOf(model)?.price,
  tier: (model) => rowOf(model)?.tier,
  lighterPrice: (model) => rowOf(model)?.lighter,
  mechanicalTools: ["Read", "Grep", "Glob", "LS", "Bash", "BashOutput", "NotebookRead"],
};
