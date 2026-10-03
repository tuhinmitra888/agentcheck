// Catalog lag tracker: how long do new products take to appear in Shopify Catalog?
// Each run picks up products published in the last WINDOW_DAYS and searches the catalog for every product still being
// tracked. A product is "in catalog" once found on two checks in a row, or a "gap" if never found within GAP_DAYS of
// publishing. No model calls; read-only catalog searches. Meant to run once a day.
//
//   npm run lag -- --stores stores.txt            daily check ("domain|Brand" per line)
//   npm run lag -- --stores stores.txt --report   time-to-catalog summary

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Catalog, type CatalogProduct } from "./catalog.js";
import { config } from "./config.js";
import { sameHost } from "./discovery.js";
import { handleFromUrl } from "./tasks.js";

const WINDOW_DAYS = 14; // track products published this recently
const GAP_DAYS = 30; // never found this long after publishing = persistent gap
const PAGES = 4; // products.json is roughly newest-first; 1,000 products covers recent launches
const INTAKE_PER_STORE = 25; // newest products added per store per run, so one prolific store (Kith) can't dominate

interface Tracked {
  domain: string;
  brand: string;
  handle: string;
  title: string;
  publishedAt: string; // YYYY-MM-DD
  checks: { date: string; found: boolean }[];
  firstFound?: string;
  status: "tracking" | "in_catalog" | "gap";
}

const { values } = parseArgs({
  options: {
    stores: { type: "string" },
    data: { type: "string", default: "results/lag" },
    report: { type: "boolean", default: false },
  },
});
if (!values.stores) throw new Error("--stores <file> is required (one 'domain|Brand' per line)");
const stores = readFileSync(values.stores, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [domain, brand] = l.split("|").map((s) => s.trim());
    return { domain: domain!, brand: brand ?? domain!.replace(/^www\./, "").split(".")[0]! };
  });

mkdirSync(values.data, { recursive: true });
const stateFile = `${values.data}/state.json`;
const state: Record<string, Tracked> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const today = new Date().toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

if (values.report) {
  report();
} else {
  await check();
  save();
}

function save() {
  writeFileSync(stateFile, JSON.stringify(state, null, 1));
}

async function check() {
  // 1. Pick up newly published products.
  for (const s of stores) {
    try {
      // New = created AND published recently. Republishing an old product resets its published date (Allbirds showed
      // 300 "new" products in two weeks), but not its created date.
      const fresh = (await recentProducts(s.domain))
        .filter((p) => days(p.createdAt, today) <= WINDOW_DAYS && days(p.publishedAt, today) <= WINDOW_DAYS && !state[`${s.domain}/${p.handle}`])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, INTAKE_PER_STORE);
      for (const p of fresh) {
        state[`${s.domain}/${p.handle}`] = { handle: p.handle, title: p.title, publishedAt: p.publishedAt, domain: s.domain, brand: s.brand, checks: [], status: "tracking" };
      }
    } catch (err) {
      console.log(`${today} ${s.domain}: could not read products (${String(err).slice(0, 120)})`);
    }
  }

  // 2. Search the catalog for everything still being tracked.
  const tracking = Object.values(state).filter((t) => t.status === "tracking" && !t.checks.some((c) => c.date === today));
  const catalog = await Catalog.connect();
  const ctx = { address_country: "US", currency: "USD" };
  try {
    for (const t of tracking) {
      let results: CatalogProduct[];
      try {
        results = [...(await catalog.search(`${t.brand} ${t.title}`, ctx)), ...(await catalog.search(t.title, ctx))];
      } catch (err) {
        // Skip, don't crash: a sleeping laptop or catalog outage shouldn't lose the run. Retried on the next run.
        console.log(`${today} ${t.domain}/${t.handle}: search failed, will retry next run (${String(err).slice(0, 100)})`);
        continue;
      }
      const found = isListed(t, results);
      t.checks.push({ date: today, found });
      if (found && !t.firstFound) t.firstFound = today;
      const last2 = t.checks.slice(-2);
      if (last2.length === 2 && last2.every((c) => c.found)) t.status = "in_catalog";
      else if (!t.firstFound && days(t.publishedAt, today) > GAP_DAYS) t.status = "gap";
      save(); // after every product, so an interrupted run keeps its progress
      await new Promise((r) => setTimeout(r, 1_000));
    }
  } finally {
    await catalog.close();
  }

  const all = Object.values(state);
  console.log(
    `${today} checked ${tracking.length} products across ${stores.length} stores; tracking ${all.filter((t) => t.status === "tracking").length}, ` +
      `in catalog ${all.filter((t) => t.status === "in_catalog").length}, gaps ${all.filter((t) => t.status === "gap").length}`,
  );
}

// Found if the store's own product comes back: same address, or its colourway inside a grouped listing.
function isListed(t: Tracked, results: CatalogProduct[]): boolean {
  const ours = results.filter((r) => r.variants.some((v) => v.url && sameHost(v.url, t.domain)));
  if (ours.some((r) => r.variants.some((v) => handleFromUrl(v.url!) === t.handle))) return true;
  const { base, colour } = splitTitle(t.title);
  return colour !== "" && ours.some((r) => splitTitle(r.title).base === base && r.options.some((o) => o.values.some((v) => matches(norm(v), colour))));
}

// Function declarations (hoisted): check() runs at top level before this point in the file.
function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function matches(a: string, b: string) {
  return a.includes(b) || b.includes(a);
}
// Colour separators seen so far: " - " (Allbirds), " | " (Good American), " in " (Away).
function splitTitle(t: string) {
  const parts = t.split(/\s(?:[|–-]|in)\s/);
  return { base: norm(parts[0]!), colour: parts.length > 1 ? norm(parts.slice(1).join(" ")) : "" };
}

async function recentProducts(domain: string) {
  const out: { handle: string; title: string; publishedAt: string; createdAt: string }[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await fetch(`https://${domain}/products.json?limit=250&page=${page}`, { headers: { "User-Agent": config.userAgent } });
    const { products = [] } = (await res.json()) as {
      products?: { handle: string; title: string; published_at?: string; created_at?: string; variants: { available?: boolean; requires_shipping?: boolean }[] }[];
    };
    for (const p of products) {
      const goods = p.variants.some((v) => v.requires_shipping !== false) && p.variants.some((v) => v.available);
      if (p.published_at && p.created_at && goods) {
        out.push({ handle: p.handle, title: p.title, publishedAt: p.published_at.slice(0, 10), createdAt: p.created_at.slice(0, 10) });
      }
    }
    if (products.length < 250) break;
  }
  return out;
}

function report() {
  const all = Object.values(state).sort((a, b) => a.domain.localeCompare(b.domain) || a.publishedAt.localeCompare(b.publishedAt));
  // The true lag lies between the last check that missed it and the first that found it (in days since publishing).
  // Found on the very first check: only an upper bound.
  const bounds = (t: Tracked) => {
    const i = t.checks.findIndex((c) => c.found);
    if (i < 0) return undefined;
    const hi = days(t.publishedAt, t.checks[i]!.date);
    return { lo: i === 0 ? 0 : days(t.publishedAt, t.checks[i - 1]!.date) + 1, hi, firstCheck: i === 0 };
  };
  console.log(`Time to catalog, ${all.length} new products tracked (as of ${today})\n`);
  for (const t of all) {
    const b = bounds(t);
    const status = b
      ? b.firstCheck ? `in catalog within ${b.hi} days (found on first check)` : `in catalog after ${b.lo === b.hi ? b.hi : `${b.lo}-${b.hi}`} days`
      : `${t.status === "gap" ? "GAP" : "not found yet"}, ${days(t.publishedAt, today)} days since publishing`;
    console.log(`${t.brand.padEnd(18)} ${t.title.slice(0, 50).padEnd(50)} published ${t.publishedAt}  ${status}  (${t.checks.length} checks)`);
  }
  const exact = all.map(bounds).filter((b): b is NonNullable<ReturnType<typeof bounds>> => !!b && !b.firstCheck);
  if (exact.length) {
    const his = exact.map((b) => b.hi).sort((x, y) => x - y);
    console.log(`\nProducts seen missing, then found (n=${exact.length}): appeared within ${his[0]}-${his.at(-1)} days of publishing, median ${his[Math.floor(his.length / 2)]}.`);
  }
  const waiting = all.filter((t) => !t.firstFound && t.status !== "gap");
  if (waiting.length) console.log(`Still waiting: ${waiting.length}; longest so far ${Math.max(...waiting.map((t) => days(t.publishedAt, today)))} days.`);
}
