// Tasks 1 (find) and 2 (compare): an agent shops through Shopify Catalog, the way ChatGPT, Copilot and Google do,
// and is graded against the store's own /products.json.

import type Anthropic from "@anthropic-ai/sdk";
import { runLoop, SUBMIT_TOOL, type LoopResult } from "./agent.js";
import type { BuyerContext, Catalog, CatalogProduct } from "./catalog.js";
import { handleFromUrl, type CompareTask, type FailureLabel, type FindTask } from "./tasks.js";

export interface Grade {
  pass: boolean;
  label?: FailureLabel;
  detail: string;
}

type Tool = Anthropic.Beta.Messages.BetaTool;

const SYSTEM = `You are an AI shopping assistant acting for a shopper. You can only see products through the catalog tools provided.
Search as a shopper would, check product details before answering, and only recommend products sold by the store the shopper named.
When you have the answer, call ${SUBMIT_TOOL}. If you cannot find what was asked for, call ${SUBMIT_TOOL} with null values rather than guessing.`;

const searchTool: Tool = {
  name: "search_catalog",
  description: "Search the shopping catalog. Returns up to 10 products with seller, price and variant details.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "What the shopper is looking for" } },
    required: ["query"],
    additionalProperties: false,
  },
};

const productTool: Tool = {
  name: "get_product",
  description: "Get full details for one product by its id from search results.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

const findSubmit: Tool = {
  name: SUBMIT_TOOL,
  description: "Submit the product you found. Use null if no matching product exists.",
  strict: true,
  input_schema: {
    type: "object",
    properties: { product_url: { type: ["string", "null"], description: "The product page URL on the store's own site" } },
    required: ["product_url"],
    additionalProperties: false,
  },
};

const compareSubmit: Tool = {
  name: SUBMIT_TOOL,
  description: "Submit the comparison, one entry per product. Use null for values you could not find.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            product_url: { type: ["string", "null"] },
            lowest_price: { type: ["number", "null"] },
            in_stock: { type: ["boolean", "null"] },
          },
          required: ["product_url", "lowest_price", "in_stock"],
          additionalProperties: false,
        },
      },
    },
    required: ["products"],
    additionalProperties: false,
  },
};

// What the agent was shown about this store's products, keyed by handle. Used to tell catalog gaps from agent mistakes.
class Seen {
  byHandle = new Map<string, CatalogProduct>();
  constructor(private storeHost: string) {}
  record(products: CatalogProduct[]) {
    for (const p of products) {
      for (const v of p.variants) {
        const h = v.url && sameHost(v.url, this.storeHost) ? handleFromUrl(v.url) : undefined;
        if (h) this.byHandle.set(h, p);
      }
    }
  }
}

function catalogExecutor(catalog: Catalog, context: BuyerContext, seen: Seen) {
  return async (name: string, input: unknown): Promise<string> => {
    if (name === "search_catalog") {
      const products = await catalog.search((input as { query: string }).query, context);
      seen.record(products);
      return JSON.stringify(products.map(forModel));
    }
    if (name === "get_product") {
      const product = await catalog.getProduct((input as { id: string }).id, context);
      if (product) seen.record([product]);
      return JSON.stringify(product ? forModel(product) : { error: "not found" });
    }
    throw new Error(`unknown tool ${name}`);
  };
}

// Keep tool results small: first 8 variants are enough to answer and keep cost inside the cap.
function forModel(p: CatalogProduct) {
  return { ...p, variants: p.variants.slice(0, 8), variantCount: p.variants.length };
}

export async function runFind(task: FindTask, domain: string, catalog: Catalog, context: BuyerContext) {
  const seen = new Seen(domain);
  const loop = await runLoop({
    system: SYSTEM,
    prompt: task.prompt,
    tools: [searchTool, productTool, findSubmit],
    execute: catalogExecutor(catalog, context, seen),
  });
  return { loop, grade: gradeFind(task, domain, loop, seen) };
}

export async function runCompare(task: CompareTask, domain: string, catalog: Catalog, context: BuyerContext) {
  const seen = new Seen(domain);
  const loop = await runLoop({
    system: SYSTEM,
    prompt: task.prompt,
    tools: [searchTool, productTool, compareSubmit],
    execute: catalogExecutor(catalog, context, seen),
  });
  return { loop, grade: gradeCompare(task, domain, loop, seen) };
}

export function gradeFind(task: FindTask, domain: string, loop: LoopResult, seen: Seen): Grade {
  const capped = capLabel(loop);
  if (capped) return capped;
  const url = (loop.answer as { product_url: string | null } | undefined)?.product_url ?? null;
  if (url && !sameHost(url, domain)) return { pass: false, label: "recommended_competitor", detail: `answered ${url}` };
  const handle = url ? handleFromUrl(url) : undefined;
  if (handle && task.acceptableHandles.includes(handle)) return { pass: true, detail: `found ${handle}` };
  const sawAcceptable = task.acceptableHandles.some((h) => seen.byHandle.has(h));
  if (!sawAcceptable) {
    return { pass: false, label: "data_missing", detail: "no acceptable product appeared in any catalog result" };
  }
  return {
    pass: false,
    label: url ? "navigation_confusing" : "gave_up",
    detail: url ? `answered ${handle ?? url}, not an acceptable product` : "saw an acceptable product but answered null",
  };
}

export function gradeCompare(task: CompareTask, domain: string, loop: LoopResult, seen: Seen): Grade {
  const capped = capLabel(loop);
  if (capped) return capped;
  const answers = (loop.answer as { products: { product_url: string | null; lowest_price: number | null; in_stock: boolean | null }[] } | undefined)?.products ?? [];
  const problems: string[] = [];
  let label: FailureLabel | undefined;
  for (const truth of task.products) {
    const answer = answers.find((a) => a.product_url && sameHost(a.product_url, domain) && handleFromUrl(a.product_url) === truth.handle);
    const shown = seen.byHandle.get(truth.handle);
    if (!answer) {
      problems.push(`${truth.handle}: no answer`);
      label ??= shown ? "navigation_confusing" : "data_missing";
      continue;
    }
    const priceOk = answer.lowest_price !== null && Math.abs(answer.lowest_price - truth.minPrice) < 0.01;
    const stockOk = answer.in_stock === truth.inStock;
    if (priceOk && stockOk) continue;
    problems.push(`${truth.handle}: said ${answer.lowest_price}/${answer.in_stock}, store has ${truth.minPrice}/${truth.inStock}`);
    // If the catalog itself showed the wrong value, the store's data is the problem; otherwise the agent misread it.
    const catalogPrice = shown?.priceRange?.min;
    const catalogWrong = catalogPrice !== undefined && Math.abs(catalogPrice - truth.minPrice) >= 0.01;
    label ??= catalogWrong ? "data_inconsistent" : "other";
  }
  return problems.length === 0
    ? { pass: true, detail: "both products correct" }
    : { pass: false, label: label ?? "other", detail: problems.join("; ") };
}

function capLabel(loop: LoopResult): Grade | undefined {
  if (loop.end === "submitted") return undefined;
  if (loop.end.startsWith("cap_")) return { pass: false, label: "cap_exceeded", detail: loop.end };
  return { pass: false, label: loop.end === "refusal" ? "other" : "gave_up", detail: loop.end };
}

export function sameHost(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const want = domain.replace(/^www\./, "");
    return host === want || host.endsWith(`.${want}`);
  } catch {
    return false;
  }
}

export { Seen };
