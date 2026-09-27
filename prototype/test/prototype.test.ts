import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopResult } from "../src/agent.js";
import { gradeCheckout, isCheckoutUrl, shouldBlock } from "../src/checkout.js";
import { costUsd } from "../src/config.js";
import { confirmMissing, gradeCompare, gradeFind, sameHost, Seen } from "../src/discovery.js";
import { evaluate } from "../src/evaluate.js";
import type { RunRecord } from "../src/run.js";
import type { StoreProduct } from "../src/store.js";
import { handleFromUrl, makeCompareTask, makeFindTask } from "../src/tasks.js";

const loop = (answer: unknown, end: LoopResult["end"] = "submitted"): LoopResult => ({
  end, answer, steps: 3, nudges: 0, toolErrors: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0.05, ms: 20_000, modelsServed: ["claude-opus-5"], transcript: [],
});

const product = (handle: string, type: string, price: number, available = true): StoreProduct => ({
  handle, title: handle.replace(/-/g, " "), productType: type, vendor: "Brand", options: [],
  variants: [{ id: handle.length, title: "Default", price, available, requiresShipping: true }],
});

const catalogHit = (handle: string, min: number) => ({
  id: `gid://${handle}`, title: handle, seller: {}, priceRange: { min, max: min, currency: "USD" }, options: [],
  variants: [{ title: handle, url: `https://www.shop.com/products/${handle}?variant=1` }],
});

test("payment guard: checkout pages load, submissions and payment hosts are blocked", () => {
  assert.equal(shouldBlock("https://www.shop.com/checkouts/cn/abc", "GET"), false);
  assert.equal(shouldBlock("https://www.shop.com/checkouts/cn/abc/graphql", "POST"), true);
  assert.equal(shouldBlock("https://checkout.shop.com/submit", "POST"), true);
  assert.equal(shouldBlock("https://deposit.shopifycs.com/sessions", "GET"), true);
  assert.equal(shouldBlock("https://www.paypal.com/checkoutnow", "GET"), true);
  assert.equal(shouldBlock("https://www.shop.com/cart/add.js", "POST"), false); // adding to cart is allowed
  assert.equal(isCheckoutUrl("https://www.shop.com/checkouts/cn/abc"), true);
  assert.equal(isCheckoutUrl("https://www.shop.com/cart"), false);
});

test("handles and hosts are read from storefront URLs", () => {
  assert.equal(handleFromUrl("https://www.shop.com/products/fox-hunt?variant=1&utm_source=shopify"), "fox-hunt");
  assert.equal(handleFromUrl("https://www.shop.com/collections/all"), undefined);
  assert.equal(sameHost("https://shop.com/products/x", "www.shop.com"), true);
  assert.equal(sameHost("https://other.com/products/x", "www.shop.com"), false);
});

test("find task accepts every product that meets the constraints", () => {
  const products = [product("a-soap", "Soap", 10), product("b-soap", "Soap", 12), product("c-soap", "Soap", 30), product("oil", "Oil", 5)];
  const task = makeFindTask("Brand", products);
  assert.equal(task.targetHandle, "c-soap"); // middle of the handle-sorted in-stock list
  assert.deepEqual(task.acceptableHandles.sort(), ["a-soap", "b-soap", "c-soap"]); // oil is cheaper but the wrong type
});

test("find grading separates catalog gaps from agent mistakes", () => {
  const task = makeFindTask("Brand", [product("a-soap", "Soap", 10), product("b-soap", "Soap", 12), product("c-soap", "Soap", 30)]);
  const seen = new Seen("www.shop.com");
  assert.equal(gradeFind(task, "www.shop.com", loop({ product_url: null }), seen).label, "data_missing");
  seen.record([catalogHit("a-soap", 10)]);
  assert.equal(gradeFind(task, "www.shop.com", loop({ product_url: "https://www.shop.com/products/a-soap" }), seen).pass, true);
  assert.equal(gradeFind(task, "www.shop.com", loop({ product_url: "https://www.shop.com/products/c-soap" }), seen).label, "navigation_confusing");
  assert.equal(gradeFind(task, "www.shop.com", loop({ product_url: "https://rival.com/products/a-soap" }), seen).label, "recommended_competitor");
  assert.equal(gradeFind(task, "www.shop.com", loop(undefined, "cap_cost"), seen).label, "cap_exceeded");
});

test("compare grading blames the store when the catalog showed the wrong price", () => {
  const task = makeCompareTask("Brand", [product("a-soap", "Soap", 10), product("b-soap", "Soap", 12)]);
  const seen = new Seen("www.shop.com");
  seen.record([catalogHit("a-soap", 10), catalogHit("b-soap", 15)]);
  const answer = (bPrice: number) => loop({
    products: [
      { product_url: "https://www.shop.com/products/a-soap", lowest_price: 10, in_stock: true },
      { product_url: "https://www.shop.com/products/b-soap", lowest_price: bPrice, in_stock: true },
    ],
  });
  assert.equal(gradeCompare(task, "www.shop.com", answer(12), seen).pass, true);
  assert.equal(gradeCompare(task, "www.shop.com", answer(15), seen).label, "data_inconsistent");
});

test("checkout grading", () => {
  const task = { kind: "checkout" as const, prompt: "", handle: "x", variantId: 42, variantTitle: "M", price: 20 };
  const cart = (variant: number, price = 2000) => ({ items: [{ variant_id: variant, quantity: 1, price }] });
  assert.equal(gradeCheckout(task, true, cart(42), false).pass, true);
  assert.equal(gradeCheckout(task, true, cart(42, 2500), false).label, "data_inconsistent");
  assert.equal(gradeCheckout(task, true, cart(7), false).label, "wrong_variant");
  assert.equal(gradeCheckout(task, false, cart(42), false).label, "checkout_unreachable");
  assert.equal(gradeCheckout(task, false, undefined, true).label, "access_blocked");
});

const rec = (store: string, task: "find" | "compare", batch: number, pass: boolean, label?: string): RunRecord => ({
  store, task, batch, run: 1, pass, label, detail: "", end: "submitted", steps: 3, nudges: 0, toolErrors: 0,
  tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0.05, ms: 20_000,
  model: "claude-opus-5", modelsServed: ["claude-opus-5"], at: "",
});

const batch = (store: string, task: "find" | "compare", b: number, passes: number, label = "data_missing") =>
  Array.from({ length: 10 }, (_, i) => rec(store, task, b, i < passes, i < passes ? undefined : label));

test("evaluate: go when pairs are stable, failures are fixable and runs stay under the caps", () => {
  const records = ["s1", "s2", "s3"].flatMap((s) => [...batch(s, "find", 1, 7), ...batch(s, "find", 2, 5)]);
  const v = evaluate(records);
  assert.equal(v.stability.unstablePairs, 0);
  assert.equal(v.usefulness.storesWithFixableFailure, 3);
  assert.equal(v.go, true);
});

test("evaluate: two pairs differing by more than 4/10 is a stability no-go", () => {
  const records = [
    ...batch("s1", "find", 1, 9), ...batch("s1", "find", 2, 3),
    ...batch("s2", "find", 1, 8), ...batch("s2", "find", 2, 2),
    ...batch("s3", "find", 1, 5), ...batch("s3", "find", 2, 5),
  ];
  const v = evaluate(records);
  assert.equal(v.stability.unstablePairs, 2);
  assert.equal(v.go, false);
});

test("evaluate: failures that are only the agent's fault fail usefulness", () => {
  const records = ["s1", "s2", "s3"].flatMap((s) => [...batch(s, "find", 1, 6, "gave_up"), ...batch(s, "find", 2, 6, "gave_up")]);
  assert.equal(evaluate(records).usefulness.pass, false);
});

test("evaluate: one run over the cost cap fails cost", () => {
  const records = [...batch("s1", "find", 1, 7), ...batch("s1", "find", 2, 7)];
  records[0] = { ...records[0]!, costUsd: 0.62 };
  assert.equal(evaluate(records).cost.pass, false);
});

test("cost counts cache writes at 1.25x and cache reads at 0.1x of the input price", () => {
  // Opus 5: $5 in / $25 out per million tokens
  assert.equal(costUsd("claude-opus-5", { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }), 5);
  assert.equal(costUsd("claude-opus-5", { input: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0 }), 6.25);
  assert.equal(costUsd("claude-opus-5", { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 0 }), 0.5);
  assert.equal(costUsd("claude-opus-5", { input: 0, cacheWrite: 0, cacheRead: 0, output: 1_000_000 }), 25);
});

test("evaluate: a single batch is not comparable, so it can't be called unstable or stable", () => {
  const v = evaluate([rec("s1", "find", 1, true)]);
  assert.equal(v.pairs[0]!.comparable, false);
  assert.equal(v.stability.unstablePairs, 0);
  assert.equal(v.stability.pass, false);
});

test("cost matches dated model snapshots to their base price", () => {
  const t = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 };
  assert.equal(costUsd("claude-haiku-4-5-20251001", t), 1);
  assert.equal(costUsd("claude-sonnet-5", t), 2);
  assert.equal(costUsd("some-unknown-model", t), 5); // unknown: Opus rate
  assert.equal(costUsd("claude-opus-5-5", t), 4); // not matched as claude-opus-5
  assert.equal(costUsd("claude-opus-5", t), 5);
});

test("compare grading reports a store gap even when the agent also got the other product wrong", () => {
  const task = makeCompareTask("Brand", [product("a-soap", "Soap", 10), product("b-soap", "Soap", 12)]);
  const seen = new Seen("www.shop.com");
  seen.record([catalogHit("a-soap", 10)]); // b-soap never appeared in the catalog
  const g = gradeCompare(task, "www.shop.com", loop({
    products: [
      { product_url: "https://www.shop.com/products/a-soap", lowest_price: 10, in_stock: false }, // agent misread stock
      { product_url: null, lowest_price: null, in_stock: null },
    ],
  }), seen);
  assert.equal(g.label, "data_missing");
});

test("store products are read across every page of /products.json", async () => {
  const pages = [250, 250, 17];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const n = pages[page - 1] ?? 0;
    const products = Array.from({ length: n }, (_, i) => ({ handle: `p${page}-${i}`, title: "x", variants: [{ id: i, title: "d", price: "1.00", available: true }] }));
    return new Response(JSON.stringify({ products }), { status: 200 });
  }) as typeof fetch;
  try {
    const { fetchStoreProducts } = await import("../src/store.js");
    assert.equal((await fetchStoreProducts("www.shop.com")).length, 517);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("password-protected stores are unlocked only when consent-listed", async () => {
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === "/password" && init?.method === "POST") {
      sent.push(`${u.hostname}:${String(init.body)}`);
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "_shopify_essential=abc; path=/; HttpOnly" } });
    }
    const unlocked = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? "").includes("_shopify_essential=abc");
    if (!unlocked) return new Response(null, { status: 302, headers: { location: `https://${u.hostname}/password` } });
    return new Response(JSON.stringify({ products: [{ handle: "a", title: "A", variants: [{ id: 1, title: "d", price: "5.00", available: true }] }] }));
  }) as typeof fetch;
  const { config } = await import("../src/config.js");
  const saved = { password: config.storePassword, consent: config.checkoutConsent };
  try {
    const { fetchStoreProducts } = await import("../src/store.js");
    config.storePassword = "s3cret";
    config.checkoutConsent = ["dev.myshopify.com"];
    assert.equal((await fetchStoreProducts("dev.myshopify.com")).length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^dev\.myshopify\.com:.*password=s3cret/);
    await assert.rejects(fetchStoreProducts("stranger.myshopify.com"), /password-protected/);
    assert.equal(sent.length, 1); // never sent to a store that isn't consent-listed
  } finally {
    globalThis.fetch = realFetch;
    config.storePassword = saved.password;
    config.checkoutConsent = saved.consent;
  }
});

test("ordinary redirects are still followed when reading products", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname === "shop.com") return new Response(null, { status: 301, headers: { location: `https://www.shop.com${u.pathname}${u.search}` } });
    return new Response(JSON.stringify({ products: [{ handle: "a", title: "A", variants: [{ id: 1, title: "d", price: "5.00", available: true }] }] }));
  }) as typeof fetch;
  try {
    const { fetchStoreProducts } = await import("../src/store.js");
    assert.equal((await fetchStoreProducts("shop.com")).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkout task skips products passed in skip (e.g. subscription products)", async () => {
  const { makeCheckoutTask } = await import("../src/tasks.js");
  const multi = (handle: string): StoreProduct => ({
    ...product(handle, "Board", 10),
    variants: [{ id: 1, title: "S", price: 10, available: true, requiresShipping: true }, { id: 2, title: "M", price: 10, available: true, requiresShipping: true }],
  });
  const products = [multi("a-wax"), multi("b-board")];
  assert.equal(makeCheckoutTask("Brand", "shop.com", products).handle, "a-wax");
  assert.equal(makeCheckoutTask("Brand", "shop.com", products, new Set(["a-wax"])).handle, "b-board");
});

test("checkout task asks for a non-default variant when one is available", async () => {
  const { makeCheckoutTask } = await import("../src/tasks.js");
  const p: StoreProduct = {
    ...product("board", "Board", 10),
    variants: [{ id: 1, title: "Ice", price: 10, available: true, requiresShipping: true }, { id: 2, title: "Dawn", price: 10, available: true, requiresShipping: true }],
  };
  assert.equal(makeCheckoutTask("Brand", "shop.com", [p]).variantTitle, "Dawn");
});

test("rate-limit errors are recognised for retry", async () => {
  const mod = await import("../src/catalog.js");
  const Catalog = mod.Catalog as unknown as { prototype: { call: Function; callOnce: Function } };
  let calls = 0;
  const fake = Object.create(Catalog.prototype);
  fake.rateLimitWaits = 0;
  fake.callOnce = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("Error POSTing to endpoint: Rate limit exceeded"), { code: 429 });
    return { products: [] };
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout; // skip the backoff wait
  try {
    assert.deepEqual(await Catalog.prototype.call.call(fake, "search_catalog", {}), { products: [] });
    assert.equal(calls, 2);
    assert.equal(fake.rateLimitWaits, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("evaluate: infrastructure failures are excluded, and pass rates keep short batches comparable", () => {
  const records = [...batch("s1", "find", 1, 7), ...batch("s1", "find", 2, 7)];
  // three batch-2 runs lost to an outage: 7/10 vs 4/7 passing is 70% vs 57%, not unstable
  for (const i of [17, 18, 19]) records[i] = { ...records[i]!, pass: false, label: "infra_error" };
  records[16] = { ...records[16]!, pass: false, label: "data_missing", toolErrors: 2 }; // catalog error: excluded too
  const v = evaluate(records);
  assert.equal(v.infraRuns, 4);
  assert.equal(v.pairs[0]!.batch2.runs, 6);
  assert.equal(v.stability.unstablePairs, 0);
});

test("data missing is confirmed by the harness's own search before the store is blamed", async () => {
  const ctx = { address_country: "US", currency: "USD" };
  const missing = { pass: false, label: "data_missing" as const, detail: "no acceptable product appeared" };
  const catalogWith = (handles: string[]) => ({
    search: async () => handles.map((h) => catalogHit(h, 10)),
  }) as unknown as Parameters<typeof confirmMissing>[3];
  const probes = [{ handle: "a-soap", title: "a soap" }];
  // catalog returns the product: the agent missed it
  assert.equal((await confirmMissing(missing, probes, "www.shop.com", catalogWith(["a-soap"]), ctx)).label, "navigation_confusing");
  // catalog doesn't: the store's gap stands
  const g = await confirmMissing(missing, probes, "www.shop.com", catalogWith(["other"]), ctx);
  assert.equal(g.label, "data_missing");
  assert.match(g.detail, /confirmed/);
});

test("compare task only picks in-stock products", () => {
  const task = makeCompareTask("Brand", [product("a-soap", "Soap", 10, false), product("b-soap", "Soap", 12), product("c-soap", "Soap", 14), product("d-soap", "Soap", 16, false)]);
  assert.deepEqual(task.products.map((p) => p.handle).sort(), ["b-soap", "c-soap"]);
});

test("compare task only uses products whose title is unique in the store", () => {
  const same = (h: string) => ({ ...product(h, "Tee", 20), title: "Knowles Henley" });
  const task = makeCompareTask("Brand", [same("henley-a"), same("henley-b"), product("pullover", "Tee", 30), product("tank", "Tee", 25)]);
  assert.deepEqual(task.products.map((p) => p.handle).sort(), ["pullover", "tank"]);
});

test("products that don't ship (donations, gift cards, digital) aren't used for tasks", async () => {
  const { isShoppable } = await import("../src/store.js");
  const donation: StoreProduct = { ...product("plant-10-trees", "Trees", 10), variants: [{ id: 1, title: "d", price: 10, available: true, requiresShipping: false }] };
  assert.equal(isShoppable(donation), false);
  assert.equal(isShoppable(product("tee", "Tee", 30)), true);
});

test("a catalog link to a dead product page is labelled data_inconsistent", async () => {
  const ctx = { address_country: "US", currency: "USD" };
  const missing = { pass: false, label: "data_missing" as const, detail: "niagara: no answer" };
  const catalog = {
    search: async () => [{ ...catalogHit("niagara-1-4-zip", 98), title: "Niagara 1/4 Zip" }],
  } as unknown as Parameters<typeof confirmMissing>[3];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => new Response(null, { status: url.endsWith("/products/niagara-1-4-zip") ? 404 : 200 })) as typeof fetch;
  try {
    const g = await confirmMissing(missing, [{ handle: "niagara-1-4-zip-meteorite-black", title: "Niagara 1/4 Zip" }], "www.shop.com", catalog, ctx);
    assert.equal(g.label, "data_inconsistent");
    assert.match(g.detail, /returns 404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
