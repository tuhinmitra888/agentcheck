// Ground truth for task answers: the store's own /products.json, independent of the catalog being tested.
// Headless stores don't serve it (0 of 11 in the hand-check); they need another source before they can be tested.

import { config } from "./config.js";
import { isPasswordPage, unlockCookie } from "./unlock.js";

export interface StoreVariant {
  id: number;
  title: string;
  price: number; // major units, store currency
  available: boolean;
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
export async function fetchStoreProducts(domain: string): Promise<StoreProduct[]> {
  const all: StoreProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchPage(domain, page);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
  throw new Error(`${domain} has more than ${PAGE_SIZE * MAX_PAGES} products; raise MAX_PAGES`);
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
      variants: { id: number; title: string; price: string; available?: boolean }[];
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
      })),
    };
  });
}

export const minPrice = (p: StoreProduct) => Math.min(...p.variants.map((v) => v.price));
export const inStock = (p: StoreProduct) => p.variants.some((v) => v.available);

// Physical goods a shopper would ask an agent about; excludes gift cards, memberships, subscriptions and free items.
const NOT_GOODS = /gift ?card|e-?gift|membership|subscription|donation|sample|warranty|insurance|shipping protection/i;
export const isShoppable = (p: StoreProduct) =>
  !NOT_GOODS.test(`${p.title} ${p.productType}`) && minPrice(p) > 0;

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
