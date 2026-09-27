// Ground truth for task answers: the store's own /products.json, independent of the catalog being tested.
// Headless stores don't serve it (0 of 11 in the hand-check); they need another source before they can be tested.

import { config } from "./config.js";

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

export async function fetchStoreProducts(domain: string, limit = 250): Promise<StoreProduct[]> {
  const res = await fetch(`https://${domain}/products.json?limit=${limit}`, {
    headers: { "User-Agent": config.userAgent, Accept: "application/json" },
  });
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
