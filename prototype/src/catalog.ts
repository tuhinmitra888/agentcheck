// Shopify Catalog client: the MCP endpoint ChatGPT, Copilot and Google use to find Shopify products.
// Read-only calls under Shopify's anonymous tier, each carrying storeprobe's agent profile.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";

// Shopify Catalog sometimes hangs (one run lost 4.5 minutes to two searches). A normal search answers in well under
// a second, so a stuck call fails fast and the agent can retry, instead of eating the run's time cap.
const CALL_TIMEOUT_MS = 20_000;
const RATE_LIMIT_RETRIES = 4;

// Rate limits (HTTP 429) and Shopify's transient "Service error. Please try again later." (MCP -32000) both clear on
// retry; the latter failed 5 of 15 stores in a teaser sweep.
function isRetryable(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  return e?.code === 429 || e?.code === -32000 || /rate limit|try again later/i.test(String(e?.message ?? err));
}

export interface BuyerContext {
  address_country: string;
  currency: string;
}

// Compact view of a catalog product: what the agent sees and what grading compares.
export interface CatalogProduct {
  id: string;
  title: string;
  seller: { name?: string; url?: string; domain?: string };
  priceRange?: { min: number; max: number; currency: string }; // major units
  options: { name: string; values: string[] }[];
  variants: { title: string; url?: string; price?: number; currency?: string; available?: boolean }[];
}

export class Catalog {
  private client = new Client({ name: "storeprobe", version: "0.0.0" });

  private constructor() {}

  static async connect(): Promise<Catalog> {
    const catalog = new Catalog();
    const transport = new StreamableHTTPClientTransport(new URL(config.catalogEndpoint), {
      requestInit: { headers: { "User-Agent": config.userAgent } },
      fetch: scopedSignalFetch,
    });
    await catalog.client.connect(transport);
    return catalog;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async search(query: string, context: BuyerContext): Promise<CatalogProduct[]> {
    const content = await this.call("search_catalog", { query, context });
    return ((content.products as unknown[]) ?? []).map(toProduct);
  }

  async getProduct(id: string, context: BuyerContext): Promise<CatalogProduct | undefined> {
    const content = await this.call("get_product", { id, context });
    const product = (content.product ?? (content.products as unknown[] | undefined)?.[0]) as unknown;
    return product ? toProduct(product) : undefined;
  }

  // Shopify's anonymous tier is rate-limited per IP (429 "Rate limit exceeded") and sometimes answers "Service error".
  // Back off and retry here so the agent never sees either: an agent that gives up on one would be graded as if the
  // store's data were missing.
  private async call(name: string, catalog: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(name, catalog);
      } catch (err) {
        if (!isRetryable(err) || attempt >= RATE_LIMIT_RETRIES) throw err;
        this.rateLimitWaits++;
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt)); // 2, 4, 8, 16 s
      }
    }
  }

  rateLimitWaits = 0; // how often this client backed off; high numbers mean runs are too dense

  private async callOnce(name: string, catalog: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.client.callTool(
      { name, arguments: { meta: { "ucp-agent": { profile: config.profileUrl } }, catalog } },
      CallToolResultSchema,
      { timeout: CALL_TIMEOUT_MS },
    );
    if (result.isError) {
      const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
      throw new Error(`${name} failed: ${text ?? "unknown error"}`);
    }
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }
}

// The SDK passes one long-lived abort signal to every request; fetch adds an abort listener to it per request and
// only drops it when the request is garbage-collected, so after ~100 catalog calls Node warns
// "MaxListenersExceededWarning" (raising the limit doesn't help: Node 22's fetch resets it to 100 per request).
// POSTs (every catalog call) get their own signal, linked to the SDK's only while the request is open. Other
// requests, like the SDK's long-lived GET stream, keep the shared signal so closing the client still cancels them.
export const scopedSignalFetch: typeof fetch = async (input, init) => {
  const parent = init?.signal;
  if (!parent || (init?.method ?? "GET").toUpperCase() !== "POST") return fetch(input, init);
  const scoped = new AbortController();
  const onAbort = () => scoped.abort(parent.reason);
  if (parent.aborted) scoped.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: scoped.signal });
  } finally {
    parent.removeEventListener("abort", onAbort);
  }
};

type Money = { amount?: number; currency?: string };
const major = (m?: Money) => (typeof m?.amount === "number" ? m.amount / 100 : undefined); // UCP amounts are minor units

function toProduct(raw: unknown): CatalogProduct {
  const p = raw as {
    id: string;
    title: string;
    price_range?: { min?: Money; max?: Money };
    options?: { name: string; values?: { label: string }[] }[];
    variants?: {
      title: string;
      url?: string;
      price?: Money;
      availability?: { available?: boolean };
      seller?: { name?: string; url?: string; domain?: string };
    }[];
  };
  const variants = p.variants ?? [];
  const min = major(p.price_range?.min);
  const max = major(p.price_range?.max);
  return {
    id: p.id,
    title: p.title,
    seller: variants[0]?.seller ?? {},
    priceRange:
      min !== undefined && max !== undefined ? { min, max, currency: p.price_range?.min?.currency ?? "" } : undefined,
    options: (p.options ?? []).map((o) => ({ name: o.name, values: (o.values ?? []).map((v) => v.label) })),
    variants: variants.map((v) => ({
      title: v.title,
      url: v.url,
      price: major(v.price),
      currency: v.price?.currency,
      available: v.availability?.available,
    })),
  };
}
