// Settings for the build-step-3 prototype. Caps come from the step 4 go/no-go criteria in the spec.

export const config = {
  profileUrl: "https://storeprobe.ai/ucp/agent-profile.json",
  catalogEndpoint: "https://catalog.shopify.com/api/ucp/mcp",
  userAgent: "storeprobe/0.0 (+https://storeprobe.ai)",
  model: process.env.STOREPROBE_MODEL ?? "claude-opus-5",
  caps: {
    maxSteps: 15, // model turns per run
    maxCostUsd: 0.5, // step 4 cost cap per run
    maxMs: 180_000, // step 4 time cap per run (3 minutes)
  },
  // Stores whose owners agreed to checkout tests. The checkout task refuses to run anywhere else.
  checkoutConsent: (process.env.STOREPROBE_CHECKOUT_STORES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// USD per million tokens. Used to enforce the cost cap; responses served by a fallback model are priced by that model.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"]!; // unknown model: price conservatively at Opus rates
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
