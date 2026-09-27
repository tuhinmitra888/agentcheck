// Settings for the build-step-3 prototype. Caps come from the step 4 go/no-go criteria in the spec.

export const config = {
  profileUrl: "https://storeprobe.ai/ucp/agent-profile.json",
  catalogEndpoint: "https://catalog.shopify.com/api/ucp/mcp",
  userAgent: "storeprobe/0.0 (+https://storeprobe.ai)",
  model: process.env.STOREPROBE_MODEL ?? "claude-opus-5-5",
  caps: {
    maxSteps: 15, // model turns per run
    maxCostUsd: 0.5, // step 4 cost cap per run
    maxMs: 180_000, // step 4 time cap per run (3 minutes)
  },
  // Storefront password for password-protected stores (development stores). Sent only to consent-listed stores.
  storePassword: process.env.STOREPROBE_STORE_PASSWORD,
  // Stores whose owners agreed to checkout tests. The checkout task refuses to run anywhere else.
  checkoutConsent: (process.env.STOREPROBE_CHECKOUT_STORES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// Models documented to accept server-side refusal fallbacks (`fallbacks: "default"`). Other models don't get the
// parameter, so a model that doesn't support it can't fail the request.
export const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

// USD per million tokens. Used to enforce the cost cap; responses served by a fallback model are priced by that model.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 }, // its cache reads are 0.025x, so the 0.1x below overstates them (safe for the cap)
  "claude-opus-5-5": { input: 4, output: 20 }, // cache reads are $0.20 (0.05x), so the 0.1x below overstates them (safe)
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface TokenUsage {
  input: number; // uncached input only
  cacheWrite: number; // 5-minute cache writes, billed at 1.25x input
  cacheRead: number; // cache hits, billed at 0.1x input
  output: number;
}

export function costUsd(model: string, t: TokenUsage): number {
  // Responses can name a dated snapshot (claude-haiku-4-5-20251001), so match on the model prefix.
  // Longest match wins, so claude-opus-5-5 isn't priced as claude-opus-5.
  const key = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  const p = PRICES[key ?? "claude-opus-5"]!; // unknown model: price conservatively at Opus rates
  return ((t.input + 1.25 * t.cacheWrite + 0.1 * t.cacheRead) * p.input + t.output * p.output) / 1_000_000;
}
