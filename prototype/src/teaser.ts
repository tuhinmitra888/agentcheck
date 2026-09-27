// Quick findability check: searches Shopify Catalog for a sample of a store's in-stock products by exact title and
// lists the ones that don't come back. No model calls; read-only catalog searches, so no consent needed.
// Exact-title search is the easiest possible test; build step 7's catalog check uses product IDs and shopper queries.
//
//   npm run teaser -- --store www.example.com --brand Example [--sample 15] [--country US --currency USD]

import { parseArgs } from "node:util";
import { Catalog } from "./catalog.js";
import { handleFromUrl } from "./tasks.js";
import { sameHost } from "./discovery.js";
import { fetchStoreProducts, inStock, isShoppable } from "./store.js";

const { values } = parseArgs({
  options: {
    store: { type: "string" },
    brand: { type: "string" },
    sample: { type: "string", default: "15" },
    country: { type: "string", default: "US" },
    currency: { type: "string", default: "USD" },
  },
});
const domain = values.store;
if (!domain) throw new Error("--store <domain> is required");
const brand = values.brand ?? domain.replace(/^www\./, "").split(".")[0]!;
const context = { address_country: values.country, currency: values.currency };

const TEASER_PAGES = 8; // a sample needs at most the first 2,000 products
const products = await fetchStoreProducts(domain, { maxPages: TEASER_PAGES, partial: true });
const candidates = products.filter((p) => isShoppable(p) && inStock(p));
const n = Math.min(Number(values.sample), candidates.length);
// Spread the sample across the catalog instead of taking the first N, which are usually the newest products.
const sample = Array.from({ length: n }, (_, i) => candidates[Math.floor((i * candidates.length) / n)]!);

const catalog = await Catalog.connect();
const missing: string[] = [];
try {
  for (const p of sample) {
    const results = await catalog.search(p.title, context);
    const found = results.some((r) =>
      r.variants.some((v) => v.url && sameHost(v.url, domain) && handleFromUrl(v.url) === p.handle),
    );
    if (!found) missing.push(`${p.title} - https://${domain}/products/${p.handle}`);
    await new Promise((r) => setTimeout(r, 300)); // gentle on Shopify's catalog
  }
} finally {
  await catalog.close();
}

console.log(`${brand}: ${missing.length} of ${n} in-stock products checked were not found in Shopify Catalog by their exact title.`);
if (products.length >= TEASER_PAGES * 250) console.log(`(Sampled from the first ${products.length} products; the store has more.)`);
console.log("(Shopify Catalog is where ChatGPT, Copilot and Google AI Mode look up Shopify products.)\n");
for (const m of missing) console.log(`- ${m}`);
