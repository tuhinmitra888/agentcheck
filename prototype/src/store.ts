// Ground truth for task answers: the store's own /products.json, independent of the catalog being tested.
// Headless stores don't serve it (0 of 11 in the hand-check); they need another source before they can be tested.

import { config } from "./config.js";
import { isPasswordPage, unlockCookie } from "./unlock.js";

export interface StoreVariant {
  id: number;
  title: string;
  price: number; // major units, store currency
  available: boolean;
  requiresShipping: boolean; // false for donations, gift cards and digital goods
}

export interface StoreProduct {
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  options: { name: string; values: string[] }[];
  variants: StoreVariant[];
}

const PAGE_SIZE = 250; // Shopify's maximum per page
const MAX_PAGES = 40; // 10,000 products

// Reads every page: a store's full catalog is the answer key, and a truncated one marks correct answers wrong.
// `partial` returns what was read when the page limit is hit (Kith has over 10,000 products); fine for sampling,
// not for an answer key, which must be complete.
export async function fetchStoreProducts(
  domain: string,
  opts: { maxPages?: number; partial?: boolean } = {},
): Promise<StoreProduct[]> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const all: StoreProduct[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(domain, page);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
  if (opts.partial) return all;
  throw new Error(`${domain} has more than ${PAGE_SIZE * maxPages} products; raise MAX_PAGES`);
}

async function fetchPage(domain: string, page: number): Promise<StoreProduct[]> {
  const url = `https://${domain}/products.json?limit=${PAGE_SIZE}&page=${page}`;
  let res = await get(url);
  if (isPasswordPage(res)) {
    res = await get(url, await unlockCookie(domain));
    if (isPasswordPage(res)) throw new Error(`${domain} stayed locked after entering the password`);
  }
  const body = await res.text();
  let data: { products?: unknown[] };
  try {
    data = JSON.parse(body);
  } catch {
    // Some headless stores answer 200 with an HTML page (Kotn in the hand-check).
    throw new Error(`${domain}/products.json is not JSON (status ${res.status}); no ground truth for this store`);
  }
  if (!res.ok || !Array.isArray(data.products)) {
    throw new Error(`${domain}/products.json unavailable (status ${res.status}); no ground truth for this store`);
  }
  return data.products.map((raw) => {
    const p = raw as {
      handle: string;
      title: string;
      product_type?: string;
      vendor?: string;
      options?: { name: string; values?: string[] }[];
      variants: { id: number; title: string; price: string; available?: boolean; requires_shipping?: boolean }[];
    };
    return {
      handle: p.handle,
      title: p.title,
      productType: p.product_type ?? "",
      vendor: p.vendor ?? "",
      options: (p.options ?? []).map((o) => ({ name: o.name, values: o.values ?? [] })),
      variants: p.variants.map((v) => ({
        id: v.id,
        title: v.title,
        price: Number(v.price),
        available: v.available ?? false,
        requiresShipping: v.requires_shipping ?? true,
      })),
    };
  });
}

export const minPrice = (p: StoreProduct) => Math.min(...p.variants.map((v) => v.price));
export const inStock = (p: StoreProduct) => p.variants.some((v) => v.available);

// Physical goods a shopper would ask an agent about; excludes gift cards, memberships, subscriptions and free items.
const NOT_GOODS = /gift ?card|e-?gift|membership|subscription|donation|sample|warranty|insurance|shipping protection/i;
// Shipping is the reliable signal: Tentree's "Plant 10 Trees" donations passed the name filter but don't ship.
export const isShoppable = (p: StoreProduct) =>
  !NOT_GOODS.test(`${p.title} ${p.productType}`) && minPrice(p) > 0 && p.variants.some((v) => v.requiresShipping);

// Follows redirects by hand so a redirect to the password page can be recognised instead of silently followed.
async function get(url: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": config.userAgent, Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  for (let hops = 0; hops < 5; hops++) {
    const res = await fetch(url, { headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || isPasswordPage(res)) return res;
    url = new URL(location, url).toString();
  }
  throw new Error(`too many redirects fetching ${url}`);
}

// Subscription (selling plan) products are poor checkout tests: the agent may pick the subscription and the price
// won't match. /products.json doesn't expose selling plans, but each product's .js endpoint does.
export async function hasSellingPlans(domain: string, handle: string): Promise<boolean> {
  const url = `https://${domain}/products/${handle}.js`;
  let res = await get(url);
  if (isPasswordPage(res)) res = await get(url, await unlockCookie(domain));
  if (!res.ok) return false;
  const p = (await res.json()) as { selling_plan_groups?: unknown[] };
  return (p.selling_plan_groups?.length ?? 0) > 0;
}
