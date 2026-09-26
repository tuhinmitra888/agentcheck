"""Throwaway hand-check of Shopify stores: static signals only, a handful of polite requests per store.

Usage: python3 handcheck.py [--mcp-tools] <domain> [<domain> ...]
  --mcp-tools  also make one read-only MCP tools/list call per store
"""
import json, re, sys, time, urllib.request, urllib.error, html as htmllib

BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
AGENTS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "Claude-SearchBot",
          "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot"]


def get(url, ua=BROWSER_UA):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "text/html,application/json,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)
    finally:
        time.sleep(1)


def robots_blocks(txt):
    """Return agents whose group disallows '/' (whole site). Simplified parser."""
    groups, cur, in_rules = {}, [], False
    for line in txt.splitlines():
        line = line.split("#")[0].strip()
        if ":" not in line:
            continue
        k, v = [s.strip() for s in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if in_rules:
                cur, in_rules = [], False
            cur.append(v.lower())
            groups.setdefault(v.lower(), [])
        elif k in ("disallow", "allow"):
            in_rules = True
            for a in cur:
                groups[a].append((k, v))
    out = {}
    for a in AGENTS:
        rules = groups.get(a.lower())
        explicit = rules is not None
        rules = rules if explicit else groups.get("*", [])
        full = any(k == "disallow" and v == "/" for k, v in rules)
        out[a] = ("BLOCKED" if full else "ok") + ("" if explicit else "*")
    return out


def jsonld_products(page):
    found = []
    for m in re.finditer(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            found.append({"_parse_error": True})
            continue
        stack = [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list):
                stack.extend(d)
            elif isinstance(d, dict):
                t = d.get("@type")
                if t == "Product" or t == "ProductGroup" or (isinstance(t, list) and "Product" in t):
                    found.append(d)
                stack.extend(v for v in d.values() if isinstance(v, (dict, list)))
    return found


def summarize_product(p):
    offers = p.get("offers") or []
    if isinstance(offers, dict):
        offers = [offers]
    variants = p.get("hasVariant") or []
    for v in variants:
        o = v.get("offers")
        offers += o if isinstance(o, list) else [o] if o else []
    prices = sorted({str(o.get("price")) for o in offers if isinstance(o, dict) and o.get("price") is not None})
    avail = sorted({str(o.get("availability", "")).split("/")[-1] for o in offers if isinstance(o, dict)})
    gtin = any(k.startswith("gtin") for k in p) or any(any(k.startswith("gtin") for k in v) for v in variants)
    sku = "sku" in p or any("sku" in v for v in variants) or any(isinstance(o, dict) and "sku" in o for o in offers)
    return {
        "type": p.get("@type"), "price": prices[:4], "availability": avail, "brand": bool(p.get("brand")),
        "gtin": gtin, "sku": sku, "rating": bool(p.get("aggregateRating")), "reviews": bool(p.get("review")),
        "description": bool(p.get("description")),
    }


def check(domain):
    base = f"https://{domain}"
    r = {"store": domain}

    s, robots = get(base + "/robots.txt")
    r["robots"] = robots_blocks(robots) if s == 200 else f"status {s}"

    s_bot, _ = get(base + "/", ua="ChatGPT-User/1.0; +https://openai.com/bot")
    s_curl, _ = get(base + "/", ua="curl/8.0")
    r["home_status"] = {"chatgpt-user UA": s_bot, "curl UA": s_curl}

    s, pj = get(base + "/products.json?limit=30")
    products = json.loads(pj).get("products", []) if s == 200 else []
    r["products_json"] = s
    prod = next((p for p in products if any(v.get("available") for v in p["variants"])), products[0] if products else None)
    if not prod:
        return r
    r["product"] = prod["handle"]
    r["variants"] = len(prod["variants"])
    r["options"] = [o["name"] for o in prod.get("options", [])]
    body = re.sub(r"<[^>]+>", " ", prod.get("body_html") or "")
    r["desc_words"] = len(body.split())
    r["images"] = len(prod.get("images", []))
    truth_prices = sorted({v["price"] for v in prod["variants"]})

    s, page = get(f"{base}/products/{prod['handle']}")
    r["pdp_status"] = s
    lds = jsonld_products(page)
    r["jsonld_blocks"] = len(lds)
    r["jsonld"] = [summarize_product(p) if "_parse_error" not in p else "PARSE ERROR" for p in lds]
    ld_prices = {float(x) for d in r["jsonld"] if isinstance(d, dict) for x in d["price"] if x not in ("None", "")}
    r["truth_prices"] = truth_prices[:4]
    r["price_match"] = bool(ld_prices) and all(float(x) in ld_prices for x in truth_prices)
    text = htmllib.unescape(re.sub(r"<script.*?</script>|<style.*?</style>", " ", page, flags=re.S | re.I))
    text = re.sub(r"<[^>]+>", " ", text)
    r["no_js_title"] = prod["title"].lower()[:25] in text.lower()
    p0 = truth_prices[0]
    p0s = p0.rstrip("0").rstrip(".") if "." in p0 else p0
    r["no_js_price"] = p0 in text or p0s in text

    for name, path in [("shipping", "/policies/shipping-policy"), ("refund", "/policies/refund-policy")]:
        s, pol = get(base + path)
        words = len(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>|<style.*?</style>", " ", pol, flags=re.S)).split())
        r[f"policy_{name}"] = f"{s}, ~{words} words" if s == 200 else s
    r["pdp_ucp_link"] = bool(re.search(r'<link[^>]*rel="ucp"', page, re.I))
    return r


def llms_txt(base):
    s, txt = get(base + "/llms.txt")
    if s != 200:
        return s
    if txt.lstrip().startswith("<"):
        return "200 (html, not text)"
    return {
        "words": len(txt.split()),
        # Shopify's platform-generated file; identical structure across stores
        "shopify_template": txt.startswith("# Agent Instructions") and "shop.app/SKILL.md" in txt,
        "mentions_ucp": "/.well-known/ucp" in txt,
    }


def ucp(base):
    s, body = get(base + "/.well-known/ucp")
    if s != 200:
        return s
    try:
        profile = json.loads(body).get("ucp", {})
    except Exception:
        return "200 (not JSON)"
    services = []
    for name, entries in (profile.get("services") or {}).items():
        for e in entries if isinstance(entries, list) else [entries]:
            services.append({"service": name, "transport": e.get("transport"), "endpoint": e.get("endpoint")})
    return {
        "version": profile.get("version"),
        "supported_versions": sorted(profile.get("supported_versions") or {}),
        "services": services,
    }


def mcp_tools(endpoint):
    """One read-only tools/list call; no other MCP methods are invoked."""
    req = urllib.request.Request(
        endpoint, method="POST",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
        headers={"User-Agent": BROWSER_UA, "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return [t["name"] for t in json.loads(resp.read()).get("result", {}).get("tools", [])]
    except Exception as e:
        return f"error: {e}"
    finally:
        time.sleep(1)


def discovery(domain, list_tools=False):
    base = f"https://{domain}"
    s, _ = get(base + "/sitemap.xml")
    r = {"sitemap": s, "llms_txt": llms_txt(base), "ucp": ucp(base)}
    if list_tools and isinstance(r["ucp"], dict):
        mcp = next((x["endpoint"] for x in r["ucp"]["services"] if x["transport"] == "mcp" and x["endpoint"]), None)
        r["mcp_tools"] = mcp_tools(mcp) if mcp else "no MCP endpoint"
    return r


if __name__ == "__main__":
    args = sys.argv[1:]
    list_tools = "--mcp-tools" in args
    for d in (a for a in args if not a.startswith("--")):
        print(json.dumps({**check(d), **discovery(d, list_tools)}, indent=1))
