# storeprobe

Open-source CLI (in development) that tests whether AI shopping agents can find, understand and check out from a store.

`public/ucp/agent-profile.json` is storeprobe's UCP agent profile. It declares catalog search and lookup only; storeprobe does not complete purchases.

Profile URL to send in `meta.ucp-agent.profile`:

    https://storeprobe.ai/ucp/agent-profile.json

It is served by a static-assets Cloudflare Worker (`wrangler.jsonc`, site files in `public/`). `public/_headers` sets `Cache-Control: public, max-age=3600`, because UCP requires `public` and `max-age>=60`; GitHub Pages can't set that header and Shopify rejects it as `profile_malformed`.

Fallback URL (same file via jsDelivr, caches `@main` for up to 7 days):

    https://cdn.jsdelivr.net/gh/tuhinmitra888/storeprobe@main/public/ucp/agent-profile.json

## License

Apache License 2.0. See [LICENSE](LICENSE).
