# storeprobe prototype (build step 3)

Rough Layer 2 prototype from the spec. It runs shopping tasks against one store many times so step 4 can decide whether agent runs are stable, useful and affordable enough to build on.

| Task | Path | Passes when |
| --- | --- | --- |
| `find` (task 1) | Shopify Catalog search, like ChatGPT, Copilot and Google | The agent names a product on the store's own site that meets the price and stock constraints |
| `compare` (task 2) | Shopify Catalog | Both products' lowest price and stock match the store's `/products.json` |
| `checkout` (task 4) | Browser on the storefront, like ChatGPT's in-app checkout | The cart holds exactly the requested variant at the right price and the checkout page is reached |

Answers are graded against the store's own `/products.json`, not the catalog being tested. Headless stores that don't serve it can't be tested yet.

## Setup

```sh
npm install
export ANTHROPIC_API_KEY=...          # or `ant auth login`
npx playwright install chromium       # only for the checkout task
```

The model defaults to `claude-opus-5` (`STOREPROBE_MODEL` to change it). On Claude Opus 5 and Claude Fable 5.1, requests opt into server-side refusal fallbacks (`fallbacks: "default"`); other models run without them.

Prompt caching is on: one breakpoint after the fixed tools and system prompt, plus automatic caching of the growing conversation. Costs count cache writes at 1.25x and reads at 0.1x the input price, and each run's console line shows the share of input served from cache.

## Run

```sh
# See the generated tasks; no model calls
npm run probe -- --store www.beardbrand.com --brand Beardbrand --tasks find,compare,checkout --dry

# Two batches of 10 runs per task (step 3), then the go/no-go verdict (step 4)
npm run probe -- --store www.beardbrand.com --brand Beardbrand --tasks find,compare --batches 2 --runs 10
npm run evaluate -- results/runs.jsonl
```

Each run appends a line to `results/runs.jsonl` and saves its full transcript under `results/transcripts/`. Use `--country` and `--currency` for stores outside the US (for example `--country GB --currency GBP`).

## Guardrails

- **Caps per run:** 15 model turns, $0.50 and 3 minutes (step 4 criteria). A run that hits a cap fails with `cap_exceeded`.
- **Password-protected stores** (every Shopify development store): set `STOREPROBE_STORE_PASSWORD` and list the store in `STOREPROBE_CHECKOUT_STORES`. The harness enters the password; the agent never sees it, and it is never sent to a store that isn't on that list.
- **Checkout needs consent.** The checkout task refuses to run unless the store is listed in `STOREPROBE_CHECKOUT_STORES` (comma-separated). Only add stores whose owners agreed.
- **No payment, ever.** The browser aborts every request to payment hosts and every non-GET request on checkout pages. The agent has no tool for typing into forms.
- **Catalog calls** are read-only, on Shopify's anonymous tier, and send storeprobe's agent profile.

## Go/no-go criteria (`npm run evaluate`)

- **Stability:** at most 1 task-store pair differs by more than 4 out of 10 between the two batches.
- **Usefulness:** at least half the stores have a failure labelled `access_blocked`, `data_missing`, `data_inconsistent`, `protocol_not_discoverable` or `checkout_unreachable`.
- **Cost and time:** every run under $0.50 and 3 minutes.

`npm test` covers task generation, grading, the payment guard and the evaluator without calling a model.
