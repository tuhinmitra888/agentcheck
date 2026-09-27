// Password-protected storefronts (every Shopify development store) redirect all pages to /password.
// The harness enters the password; the agent never sees or types it. It is only ever sent to stores on the
// consent list, so running against a stranger's protected store can't leak it.

import type { BrowserContext } from "playwright";
import { config } from "./config.js";

const PASSWORD_FORM = (password: string) => ({ password });

export function passwordFor(domain: string): string | undefined {
  return config.storePassword && config.checkoutConsent.includes(domain.toLowerCase()) ? config.storePassword : undefined;
}

export function isPasswordPage(res: Response): boolean {
  const location = res.headers.get("location") ?? "";
  return /\/password\b/.test(location) || /\/password\b/.test(new URL(res.url || "https://x/").pathname);
}

const cookies = new Map<string, string>(); // domain -> Cookie header after unlocking

// Returns the Cookie header that unlocks the storefront for plain fetch requests.
export async function unlockCookie(domain: string): Promise<string> {
  const cached = cookies.get(domain);
  if (cached) return cached;
  const password = passwordFor(domain);
  if (!password) {
    throw new Error(
      `${domain} is password-protected. Set STOREPROBE_STORE_PASSWORD and list the store in STOREPROBE_CHECKOUT_STORES (stores you own or have consent for).`,
    );
  }
  const res = await fetch(`https://${domain}/password`, {
    method: "POST",
    redirect: "manual",
    headers: { "User-Agent": config.userAgent, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(PASSWORD_FORM(password)).toString(),
  });
  // Success redirects away from /password and sets the session cookie (currently _shopify_essential). Judge by the
  // redirect rather than a cookie name, which Shopify has changed before (it used to be storefront_digest).
  const location = res.headers.get("location") ?? "";
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  if (res.status < 300 || res.status >= 400 || /\/password\b/.test(location) || !cookie) {
    throw new Error(`could not unlock ${domain}: wrong STOREPROBE_STORE_PASSWORD?`);
  }
  cookies.set(domain, cookie);
  return cookie;
}

// Unlocks the storefront inside a browser context; the context's cookie jar keeps it unlocked for the agent.
export async function unlockBrowser(context: BrowserContext, domain: string): Promise<void> {
  const password = passwordFor(domain);
  if (!password) return;
  await context.request.post(`https://${domain}/password`, { form: PASSWORD_FORM(password), maxRedirects: 0 });
}
