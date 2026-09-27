// The spec's v0.1 tasks, generated from the store's own catalog so they are realistic and checkable:
//   find     (task 1) - find a product matching constraints, via Shopify Catalog
//   compare  (task 2) - compare two products on price and stock, via Shopify Catalog
//   checkout (task 4) - add a specific variant to the cart and reach checkout, in a browser on the storefront
// Tasks are chosen deterministically so every run in both batches repeats the same task.

import { inStock, isShoppable, minPrice, type StoreProduct } from "./store.js";

export type TaskKind = "find" | "compare" | "checkout";

// Owner-fixable labels count toward the step 4 usefulness criterion; the rest don't.
export const OWNER_FIXABLE = [
  "access_blocked",
  "data_missing",
  "data_inconsistent",
  "protocol_not_discoverable",
  "checkout_unreachable",
] as const;
export type FailureLabel =
  | (typeof OWNER_FIXABLE)[number]
  | "navigation_confusing"
  | "wrong_variant"
  | "recommended_competitor"
  | "gave_up"
  | "cap_exceeded"
  | "other";

export interface FindTask {
  kind: "find";
  prompt: string;
  acceptableHandles: string[]; // every store product that satisfies the constraints
  targetHandle: string; // the product the constraints were built from
}

export interface CompareTask {
  kind: "compare";
  prompt: string;
  products: { handle: string; title: string; minPrice: number; inStock: boolean }[];
}

export interface CheckoutTask {
  kind: "checkout";
  prompt: string;
  handle: string;
  variantId: number;
  variantTitle: string;
  price: number;
}

export type Task = FindTask | CompareTask | CheckoutTask;

const byHandle = (a: StoreProduct, b: StoreProduct) => a.handle.localeCompare(b.handle);

export function makeFindTask(brand: string, products: StoreProduct[]): FindTask {
  const candidates = products.filter((p) => isShoppable(p) && inStock(p) && p.productType).sort(byHandle);
  const target = candidates[Math.floor(candidates.length / 2)];
  if (!target) throw new Error("no in-stock product with a product type to build a find task from");
  const ceiling = Math.ceil(minPrice(target));
  const type = target.productType.toLowerCase();
  const acceptable = products.filter(
    (p) => isShoppable(p) && p.productType.toLowerCase() === type && inStock(p) && minPrice(p) <= ceiling,
  );
  return {
    kind: "find",
    prompt: `I want to buy something from ${brand}'s "${target.productType}" range that costs no more than ${ceiling} and is in stock. Find one and give me its product page URL on ${brand}'s own store.`,
    acceptableHandles: acceptable.map((p) => p.handle),
    targetHandle: target.handle,
  };
}

export function makeCompareTask(brand: string, products: StoreProduct[]): CompareTask {
  // Two products of the store's most common type, so the comparison is one a shopper would actually make.
  const byType = new Map<string, StoreProduct[]>();
  for (const p of products.filter((p) => isShoppable(p) && p.productType)) {
    byType.set(p.productType, [...(byType.get(p.productType) ?? []), p]);
  }
  const group = [...byType.values()].filter((g) => g.length >= 2).sort((x, y) => y.length - x.length || byHandle(x[0]!, y[0]!))[0];
  if (!group) throw new Error("no two products share a product type; cannot build a compare task");
  const sorted = group.sort(byHandle);
  const mid = Math.floor((sorted.length - 1) / 2);
  const [a, b] = [sorted[mid]!, sorted[mid + 1]!];
  return {
    kind: "compare",
    prompt: `Compare these two products from ${brand}: "${a.title}" and "${b.title}". For each, tell me its lowest price and whether it is in stock.`,
    products: [a, b].map((p) => ({ handle: p.handle, title: p.title, minPrice: minPrice(p), inStock: inStock(p) })),
  };
}

export function makeCheckoutTask(brand: string, domain: string, products: StoreProduct[], skip = new Set<string>()): CheckoutTask {
  const shoppable = products.filter((p) => isShoppable(p) && inStock(p) && !skip.has(p.handle)).sort(byHandle);
  const product = shoppable.find((p) => p.variants.length > 1) ?? shoppable[0];
  // Prefer an available variant other than the first: the first is usually preselected, so asking for it would
  // pass without the agent ever using the variant picker.
  const available = product?.variants.filter((v) => v.available) ?? [];
  const variant = available.find((v) => v !== product?.variants[0]) ?? available[0];
  if (!product || !variant) throw new Error("no in-stock variant to build a checkout task from");
  const which = product.variants.length > 1 ? ` in "${variant.title}"` : "";
  return {
    kind: "checkout",
    prompt: `On ${brand}'s store (https://${domain}), add one "${product.title}"${which} to the cart and go to checkout. Stop at the checkout page; do not enter any personal or payment details.`,
    handle: product.handle,
    variantId: variant.id,
    variantTitle: variant.title,
    price: variant.price,
  };
}

// Pulls the product handle out of a storefront URL such as https://shop.com/products/some-handle?variant=1
export function handleFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(/\/products\/([^/?#]+)/)?.[1];
  } catch {
    return undefined;
  }
}
