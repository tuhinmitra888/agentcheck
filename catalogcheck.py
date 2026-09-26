"""Does each store show up in Shopify Catalog, and do catalog details match the store's own data?

Usage: python3 catalogcheck.py [<domain> ...]   (no arguments: all stores in STORES)
Makes anonymous-tier search_catalog calls with storeprobe's agent profile, about 4 per store.
"""
import json, re, sys, time, urllib.request, urllib.error, html as htmllib
from urllib.parse import urlparse

import handcheck as h

CATALOG = "https://catalog.shopify.com/api/ucp/mcp"
PROFILE = "https://storeprobe.ai/ucp/agent-profile.json"

STORES = [  # domain, brand, country, currency
    ("www.allbirds.com", "Allbirds", "US", "USD"),
    ("www.deathwishcoffee.com", "Death Wish Coffee", "US", "USD"),
    ("www.beardbrand.com", "Beardbrand", "US", "USD"),
    ("www.tentree.com", "tentree", "US", "USD"),
    ("www.hiutdenim.co.uk", "Hiut Denim", "GB", "GBP"),
    ("skims.com", "SKIMS", "US", "USD"),
    ("mejuri.com", "Mejuri", "US", "USD"),
    ("www.tecovas.com", "Tecovas", "US", "USD"),
    ("nour-hammour.com", "Nour Hammour", "US", "USD"),
    ("kotn.com", "Kotn", "US", "USD"),
    ("www.seedlipdrinks.com", "Seedlip", "US", "USD"),
    ("ruggable.com", "Ruggable", "US", "USD"),
    ("www.bombas.com", "Bombas", "US", "USD"),
    ("www.wearfigs.com", "FIGS", "US", "USD"),
    ("www.gymshark.com", "Gymshark", "US", "USD"),
    ("takearecess.com", "Recess", "US", "USD"),
]


def search(query, country, currency):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_catalog", "arguments": {
        "meta": {"ucp-agent": {"profile": PROFILE}},
        "catalog": {"query": query, "context": {"address_country": country, "currency": currency}}}}}
    req = urllib.request.Request(CATALOG, method="POST", data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "storeprobe/0.0 (+https://github.com/tuhinmitra888/storeprobe)"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read()[:200]!r}"
    except Exception as e:
        return f"error: {e}"
    finally:
        time.sleep(1.5)
    if "error" in d:
        return f"error: {d['error'].get('message')}"
    return d["result"]["structuredContent"].get("products", [])


def host(u):
    return (urlparse(u).hostname or "").removeprefix("www.")


def same_site(hst, store_hosts):
    return any(hst == x or hst.endswith("." + x) for x in store_hosts if x)


def is_ours(variant, store_hosts):
    s = variant.get("seller") or {}
    return (same_site(host(s.get("url", "")), store_hosts) or s.get("domain") in store_hosts
            or same_site(host(variant.get("url", "")), store_hosts))


def product_urls_from_sitemap(domain):
    s, sm = h.get(f"https://{domain}/sitemap.xml")
    locs = [htmllib.unescape(l) for l in re.findall(r"<loc>([^<]+)</loc>", sm or "")]
    subs = [l for l in locs if l.endswith(".xml")]
    if subs and len(subs) == len(locs):  # sitemap index: locale or type sub-sitemaps
        pick = [l for l in subs if "product" in l.lower()] or [l for l in subs if re.search(r"/(en-us|us-en)/", l)] or subs[:1]
        locs = []
        for sub in pick[:2]:
            s, c = h.get(sub)
            inner = [htmllib.unescape(l) for l in re.findall(r"<loc>([^<]+)</loc>", c or "")]
            if inner and all(x.endswith(".xml") for x in inner):  # one more level
                prod = [x for x in inner if "product" in x.lower()][:1]
                for x in prod:
                    s, c2 = h.get(x)
                    locs += [htmllib.unescape(l) for l in re.findall(r"<loc>([^<]+)</loc>", c2 or "")]
            else:
                locs += inner
    return [u for u in locs if re.search(r"/(products|shop)/[^/\[]+$", u) and "gift" not in u.lower()]


def store_products(domain):
    """Up to 3 products: from /products.json (with prices), else titles from sitemap product pages."""
    s, pj = h.get(f"https://{domain}/products.json?limit=50")
    try:
        prods = json.loads(pj).get("products", []) if s == 200 else []
    except ValueError:
        prods = []  # e.g. 200 with an HTML page
    prods = [p for p in prods if any(v.get("available") for v in p["variants"])]
    if prods:
        return "products.json", [{"title": p["title"], "handle": p["handle"],
                 "prices": sorted({round(float(v["price"]) * 100) for v in p["variants"]})}
                for p in prods[::max(1, len(prods) // 3)][:3]]
    urls = list(dict.fromkeys(product_urls_from_sitemap(domain)))
    out = []
    for u in urls[::max(1, len(urls) // 3)][:3]:
        s, page = h.get(u)
        m = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', page or "") or re.search(r"<title>([^<]+)</title>", page or "")
        if m:
            t = re.split(r" [|–-] (?=[^-|–]*$)", htmllib.unescape(m.group(1)).strip())[0] if " | " in m.group(1) else htmllib.unescape(m.group(1)).strip()
            out.append({"title": t, "handle": u.rstrip("/").rsplit("/", 1)[-1]})
    return ("sitemap" if out else "none"), out


def norm(t):
    return re.sub(r"[^a-z0-9 ]", " ", t.lower().replace("’", "'")).split()


def exact(prod, want, hosts):
    """True if a catalog product is the store product we searched for (handle in URL, or near-identical title)."""
    from difflib import SequenceMatcher
    for v in prod.get("variants", []):
        if is_ours(v, hosts) and want["handle"] and ("/" + want["handle"]) in (v.get("url") or ""):
            return True
    return SequenceMatcher(None, " ".join(norm(prod["title"])), " ".join(norm(want["title"]))).ratio() >= 0.9


def check(domain, brand, country, currency):
    r = {"store": domain}
    u = h.ucp(f"https://{domain}")
    hosts = {domain.removeprefix("www.")}
    if isinstance(u, dict):
        hosts |= {host(x["endpoint"]) for x in u["services"] if x.get("endpoint")}
    res = search(brand, country, currency)
    if isinstance(res, str):
        r["brand_search"] = res
    else:
        ours = [p for p in res if any(is_ours(v, hosts) for v in p.get("variants", []))]
        r["brand_search"] = f"{len(ours)}/{len(res)} results from store"
        sellers = {(v.get("seller") or {}).get("url") for p in res[:5] for v in p.get("variants", [])[:1]}
        if not ours:
            r["brand_top_sellers"] = sorted(s for s in sellers if s)[:5]
    source, prods = store_products(domain)
    r["title_source"] = source
    r["titles"] = []
    for p in prods:
        res = search(p["title"], country, currency)
        row = {"title": p["title"][:60]}
        if isinstance(res, str):
            row["result"] = res
            r["titles"].append(row)
            continue
        ours = [(i, prod) for i, prod in enumerate(res) if any(is_ours(v, hosts) for v in prod.get("variants", []))]
        hit = next(((i, prod) for i, prod in ours if exact(prod, p, hosts)), None)
        if not hit:
            row["result"] = "exact product not in top %d" % len(res) + (f" ({len(ours)} other store products)" if ours else "")
        else:
            i, prod = hit
            vs = [v for v in prod["variants"] if is_ours(v, hosts)]
            cat_prices = sorted({v["price"]["amount"] for v in vs if v.get("price")})
            cur = {v["price"]["currency"] for v in vs if v.get("price")}
            row["result"] = f"rank {i + 1}"
            row["catalog_title"] = prod["title"][:60]
            row["catalog_prices"] = cat_prices[:4]
            row["catalog_available"] = any(v.get("availability", {}).get("available") for v in vs)
            if "prices" in p:
                row["store_prices"] = p["prices"][:4]
                row["price_match"] = (set(cat_prices) <= set(p["prices"])) if cur == {currency} else f"currency {cur}"
            row["has_rating"] = bool(prod.get("rating"))
            row["ai_metadata"] = bool(prod.get("metadata"))
        r["titles"].append(row)
    return r


if __name__ == "__main__":
    only = sys.argv[1:]
    for s in STORES:
        if only and s[0] not in only:
            continue
        try:
            print(json.dumps(check(*s)), flush=True)
        except Exception as e:
            print(json.dumps({"store": s[0], "crash": repr(e)[:200]}), flush=True)
