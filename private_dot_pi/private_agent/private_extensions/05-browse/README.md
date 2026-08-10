# Browse

Browse is Pi's provider-neutral web retrieval extension. It exposes one discriminated `web_retrieval` tool for `search`, `fetch`, and `research`. Linkup is primary, with Tavily enabled as its fallback; Tavily research remains a degraded advanced sourced search. Provider adapters implement a narrow interface so a future self-hosted adapter can be added without changing the router or tool schema.

Non-secret configuration (provider base URLs, fallbackProviders, limits) is in Pi's settings under the `browse` key. Provider API keys are in `agent/browsers.json` (chmod 0600). `LINKUP_API_KEY` and `TAVILY_API_KEY` environment variables override the credentials file.

The extension validates public HTTP(S) fetch URLs before passing them to a provider and never fetches user targets directly from the Pi host. All normalized results mark returned web material as untrusted.
