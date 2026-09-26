# storeprobe

Open-source CLI (in development) that tests whether AI shopping agents can find, understand and check out from a store.

`public/ucp/agent-profile.json` is storeprobe's UCP agent profile. It declares catalog search and lookup only; storeprobe does not complete purchases.

Profile URL to send in `meta.ucp-agent.profile`:

    https://cdn.jsdelivr.net/gh/tuhinmitra888/storeprobe@main/public/ucp/agent-profile.json

Use the jsDelivr URL, not GitHub Pages: UCP requires the profile to be served with `Cache-Control: public, max-age>=60`, and GitHub Pages sends `max-age=600` without `public`, which Shopify rejects as `profile_malformed`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
