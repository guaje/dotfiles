# web_retrieval extension

Provider-neutral Pi web retrieval. It exposes one discriminated `web_retrieval` tool for `search`, `fetch`, and `research`. Linkup is primary, with Tavily enabled as its fallback; Tavily research remains a degraded advanced sourced search. Provider adapters implement a narrow interface so a future self-hosted adapter can be added without changing the router or tool schema.

Configuration, including provider credentials and limits, is in [`assets/web-retrieval.json`](./assets/web-retrieval.json), not Pi's global settings. `LINKUP_API_KEY` and `TAVILY_API_KEY` environment variables override their respective configured keys.

The extension validates public HTTP(S) fetch URLs before passing them to a provider and never fetches user targets directly from the Pi host. All normalized results mark returned web material as untrusted.
