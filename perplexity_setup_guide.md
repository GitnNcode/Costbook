Integrate the Perplexity Agent API into this project.

Work inside the project I have open: use its existing language tooling, package manager, framework, and error-handling conventions. Do not scaffold a new demo app unless the project is empty. Install only the dependencies the integration needs.

Context — the Perplexity API platform (one key for all APIs):
- Router API (`POST /router/v1/chat/completions`, `/router/v1/messages`): direct access to frontier models from Anthropic, OpenAI, Google, xAI, and Perplexity through OpenAI- or Anthropic-compatible schemas. No web grounding. Uses the OpenAI/Anthropic SDKs with a base URL — not the Perplexity SDK.
- Agent API (`POST /v1/agent`): web-grounded, multi-provider responses with tools (`web_search`, `fetch_url`, `finance_search`, code execution), presets, conversation state, and structured output. Uses the official Perplexity SDKs.
- Search API (`POST /search`): raw ranked web results as structured data for your own processing — no LLM answer.
- Embeddings API: standard and contextualized text embeddings for semantic search and RAG.
- Decisions API (`POST /v1/decisions`): probabilities instead of text for questions about content you supply: yes or no, one of your options, or a level on your rubric. For classification, routing, and scoring. No web grounding.

I chose the Agent API. If while reading this project you conclude a different Perplexity API fits its needs better, say so and why before writing code.

What to build: add a web-grounded answer capability to this project with the Perplexity Agent API.

- Endpoint: `POST https://api.perplexity.ai/v1/agent` (`/v1/responses` is an OpenAI-compat alias).
- Either pick a model (`model: "openai/gpt-5.6-sol"` etc.) or a preset (`preset: "low" | "medium" | ...`) — presets bundle model, tools, and limits.
- Read answers from the `output_text` convenience property; inspect `response.output` only when you need tool results. `search_results` items carry source metadata, while text-content `annotations` carry URL citations when present.
- Web grounding is a tool: pass `tools: [{"type": "web_search"}]` (also available: `fetch_url`, `finance_search`, and code execution with `sandbox`). Presets may enable tools already.
- Multi-turn: replay prior input or pass `previous_response_id`.
- Structured output via `response_format` JSON schema when this project needs parseable results.

TypeScript: Install the official SDK: `npm install @perplexity-ai/perplexity_ai`. Respect the repo's package manager and tsconfig.

Ground rules:
- The published docs are the source of truth. Start from the index at https://docs.perplexity.ai/llms.txt and read the pages linked below before writing code. Copy endpoints, headers, and request shapes exactly — do not guess parameter names, nesting, or response fields.
- The API key is a secret. Resolve it from the `PERPLEXITY_API_KEY` environment variable. Never hardcode, print, log, or commit it; check presence only (e.g. `test -n "$PERPLEXITY_API_KEY"`). If it is missing, tell me to create one in the API Console (https://console.perplexity.ai) and export it in my own terminal — never ask me to paste it into this chat. If the key is ever exposed, tell me to rotate it in the console.

Verify, then report:
1. Smoke-test with a minimal real request; print only the HTTP status or the response shape, never the key. Expect 200 — a 401 means an authentication/key problem; a 429 means rate limiting or, for the Router API, temporary model overload, so honor `Retry-After` (https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers).
2. Run the project's own lint/type/test commands.
3. Report files changed, commands run, and one example invocation.

Key docs:
- https://docs.perplexity.ai/docs/agent-api/quickstart
- https://docs.perplexity.ai/docs/agent-api/presets
- https://docs.perplexity.ai/docs/agent-api/tools/overview
- https://docs.perplexity.ai/docs/agent-api/output-control
- https://docs.perplexity.ai/api-reference/agent-post
- https://docs.perplexity.ai/docs/sdk/overview
- https://docs.perplexity.ai/docs/getting-started/pricing