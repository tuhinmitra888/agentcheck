// Task 4 (checkout): an agent drives a real browser on the storefront, the path ChatGPT's in-app checkout takes.
// Guardrails (spec): runs only on stores whose owners consented, can never pay, and never types personal details.

import { chromium, type Page, type Route } from "playwright";
import { runLoop, SUBMIT_TOOL } from "./agent.js";
import { config } from "./config.js";
import type { Grade } from "./discovery.js";
import type { CheckoutTask } from "./tasks.js";
import type Anthropic from "@anthropic-ai/sdk";

type Tool = Anthropic.Beta.Messages.BetaTool;

// Hosts that handle card data or wallets. Requests to them are always aborted.
const PAYMENT_HOSTS = [
  "deposit.shopifycs.com", // Shopify card vault
  "pay.shopify.com",
  "shop.app",
  "paypal.com",
  "stripe.com",
  "klarna.com",
  "afterpay.com",
  "affirm.com",
];

export function isCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\/checkouts?\//.test(u.pathname) || u.hostname.startsWith("checkout.");
  } catch {
    return false;
  }
}

// The payment block, enforced in the browser rather than the prompt: checkout pages may load (GET),
// but nothing on a checkout or payment host may be submitted.
export function shouldBlock(url: string, method: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return isCheckoutUrl(url) && method.toUpperCase() !== "GET";
}

const SYSTEM = `You are an AI shopping assistant using a web browser for a shopper. Use the tools to look at pages and click.
You cannot type into forms. Never try to pay. As soon as you reach the checkout page, call ${SUBMIT_TOOL}.
If you cannot add the item or reach checkout, call ${SUBMIT_TOOL} with reached_checkout set to false.`;

const tools: Tool[] = [
  {
    name: "read_page",
    description: "Read the current page: URL, title, visible text, and numbered interactive elements.",
    strict: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_url",
    description: "Open a URL on the store's own site.",
    strict: true,
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "click",
    description: "Click an interactive element by its number from read_page.",
    strict: true,
    input_schema: { type: "object", properties: { ref: { type: "integer" } }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "select_option",
    description: "Choose an option in a dropdown element by its number from read_page and the option's visible label.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" }, label: { type: "string" } },
      required: ["ref", "label"],
      additionalProperties: false,
    },
  },
  {
    name: SUBMIT_TOOL,
    description: "Finish: report whether you reached the checkout page.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reached_checkout: { type: "boolean" } },
      required: ["reached_checkout"],
      additionalProperties: false,
    },
  },
];

export async function runCheckout(task: CheckoutTask, domain: string) {
  if (!config.checkoutConsent.includes(domain.toLowerCase())) {
    throw new Error(`${domain} has not consented to checkout tests; add it to STOREPROBE_CHECKOUT_STORES only with the owner's agreement`);
  }
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ userAgent: `Mozilla/5.0 (compatible; ${config.userAgent})` });
    await context.route("**/*", (route: Route) =>
      shouldBlock(route.request().url(), route.request().method()) ? route.abort("blockedbyclient") : route.continue(),
    );
    const page = await context.newPage();
    await page.goto(`https://${domain}/`, { waitUntil: "domcontentloaded" });

    const loop = await runLoop({ system: SYSTEM, prompt: task.prompt, tools, execute: browserExecutor(page, domain) });

    const cart = await readCart(context.request, domain);
    return { loop, grade: gradeCheckout(task, isCheckoutUrl(page.url()), cart, await pageLooksBlocked(page)) };
  } finally {
    await browser.close();
  }
}

function browserExecutor(page: Page, domain: string) {
  return async (name: string, input: unknown): Promise<string> => {
    const i = input as { url?: string; ref?: number; label?: string };
    if (name === "open_url") {
      const url = new URL(i.url!, `https://${domain}`);
      if (!url.hostname.replace(/^www\./, "").endsWith(domain.replace(/^www\./, ""))) {
        throw new Error("only URLs on the store's own site can be opened");
      }
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    } else if (name === "click") {
      await page.locator(`[data-sp-ref="${i.ref}"]`).click({ timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    } else if (name === "select_option") {
      await page.locator(`[data-sp-ref="${i.ref}"]`).selectOption({ label: i.label! }, { timeout: 10_000 });
    } else if (name !== "read_page") {
      throw new Error(`unknown tool ${name}`);
    }
    if (isCheckoutUrl(page.url())) return `You are on the checkout page (${page.url()}). Call ${SUBMIT_TOOL} now.`;
    return JSON.stringify(await snapshot(page));
  };
}

// Numbers the visible interactive elements so the model can refer to them.
async function snapshot(page: Page) {
  const elements = await page.evaluate(() => {
    const out: { ref: number; tag: string; text: string; options?: string[] }[] = [];
    const nodes = document.querySelectorAll("a[href], button, select, input[type=submit], input[type=button], [role=button]");
    let ref = 0;
    for (const el of Array.from(nodes)) {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      el.setAttribute("data-sp-ref", String(ref));
      const text = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || (el as HTMLInputElement).value || "").trim().slice(0, 80);
      const options = el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => o.label).slice(0, 30) : undefined;
      out.push({ ref, tag: el.tagName.toLowerCase(), text, ...(options ? { options } : {}) });
      if (++ref >= 120) break;
    }
    return out;
  });
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 3000);
  return { url: page.url(), title: await page.title(), text, elements };
}

async function readCart(request: import("playwright").APIRequestContext, domain: string) {
  const res = await request.get(`https://${domain}/cart.js`).catch(() => undefined);
  if (!res?.ok()) return undefined;
  return (await res.json()) as { items: { variant_id: number; quantity: number; price: number }[] };
}

async function pageLooksBlocked(page: Page): Promise<boolean> {
  const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return /captcha|verify you are human|access denied|are you a robot/.test(text);
}

export function gradeCheckout(
  task: CheckoutTask,
  reachedCheckout: boolean,
  cart: { items: { variant_id: number; quantity: number; price: number }[] } | undefined,
  blocked: boolean,
): Grade {
  const line = cart?.items.find((it) => it.variant_id === task.variantId);
  const exact = line?.quantity === 1 && cart?.items.length === 1;
  if (reachedCheckout && exact) {
    const priceOk = Math.abs(line.price / 100 - task.price) < 0.01;
    return priceOk
      ? { pass: true, detail: "reached checkout with the right item" }
      : { pass: false, label: "data_inconsistent", detail: `cart price ${line.price / 100}, store data ${task.price}` };
  }
  if (blocked) return { pass: false, label: "access_blocked", detail: "bot challenge or access-denied page" };
  if (cart?.items.length && !line) return { pass: false, label: "wrong_variant", detail: "cart holds a different variant" };
  if (line && !reachedCheckout) return { pass: false, label: "checkout_unreachable", detail: "item in cart but checkout not reached" };
  return { pass: false, label: "navigation_confusing", detail: reachedCheckout ? "cart does not match the task" : "item never added" };
}
