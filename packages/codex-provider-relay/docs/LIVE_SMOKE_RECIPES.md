# Live Smoke Recipes

These recipes are for validating `@codex-provider/core` against real upstream services before public packaging.

Historical names under `@codexbridge/codex-provider-relay` and `codex-provider-relay-server` remain as deprecated aliases during the stabilization cycle.

Live smoke tests are intentionally manual or opt-in. They require provider credentials, may call paid APIs, and should never run in ordinary unit test flows.

## Environment

Run from the repository root unless noted otherwise.

```bash
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=deepseek/deepseek-chat
export TAVILY_API_KEY=...
export EMBEDDINGS_API_KEY=...
export EMBEDDINGS_API_ENDPOINT=https://openrouter.ai/api/v1/embeddings
export EMBEDDINGS_MODEL=qwen/qwen3-embedding-8b
```

Requesty is an OpenAI-compatible gateway and can be smoke-tested the same way (`provider/model` naming):

```bash
export REQUESTY_API_KEY=...
export REQUESTY_BASE_URL=https://router.requesty.ai/v1
export REQUESTY_DEFAULT_MODEL=openai/gpt-4o-mini
```

The embedding endpoint/model are defaults only. Any OpenAI-compatible embeddings API can be used.

## Smoke 1: Mixed Runtime

Goal: verify a non-OpenAI Chat Completions provider can be exposed to Codex as a local Responses-compatible adapter.

```bash
pnpm --dir packages/codex-provider-relay build
node packages/codex-provider-relay/dist/cli.js \
  --env-file .env.live-openai-compatible.local
```

Expected:

- Server starts and prints a local base URL.
- `GET /v1/models` returns a non-empty model list.
- `POST /v1/responses` translates a simple text request and returns a Responses-shaped object.

## Smoke 2: Relay-Emulated Web Search

Goal: verify `web_search` is explicit, executor-backed, and does not silently call live search when `external_web_access` is disabled.

Use `examples/relay-emulated-web-search.ts` as the wiring reference.

Expected:

- `{ name: "web_search", mode: "relay-emulated" }` is declared.
- `hostedToolExecutors.web_search` is registered.
- A live query returns `results`, `sources`, and `retrieved_at`.
- A request with `external_web_access: false` fails clearly unless an offline/cache source is configured.

## Smoke 3: Relay-Emulated File Search Local Vector

Goal: verify local-vector indexing, cache reuse, and OpenAI-compatible search result output.

Use `examples/relay-emulated-file-search-local-vector.ts` as the wiring reference.

Expected:

- Roots are explicit. The process working directory is not scanned implicitly.
- First query chunks files and calls the embedding provider.
- Second query reuses cached document/chunk embeddings.
- Result content uses `data[]` entries with `file_id`, `filename`, `score`, `attributes`, and `content[]`.
- A Responses request with `include: ["file_search_call.results"]` exposes a `file_search_call` item in `output`.

## Smoke 4: Image Generation Contract

Goal: verify the relay can call a host-provided image provider without bundling a default one.

Use `examples/relay-emulated-image-generation.ts` as the wiring reference.

Expected:

- No image provider is active unless `createCodexProviderImageGenerationExecutor()` is registered.
- The provider receives prompt/options.
- Optional `include: ["image_generation_call.results"]` exposes `image_generation_call` output.

## Smoke 5: Unsafe Tool Refusal By Default

Goal: verify unsafe tools cannot run unless a host explicitly supplies an executor.

Validate:

- `code_interpreter` without executor is not exposed or fails clearly.
- `computer` without executor is not exposed or fails clearly.
- Shell-like execution is not provided by this package.

## Required Evidence Before Public Release

For each live smoke, record:

- Provider and model.
- Date.
- Environment variables used, with secrets redacted.
- Request shape.
- Response shape.
- Any provider-specific incompatibility.
- Cost/latency notes.

Do not commit real API keys, local absolute paths containing private user data, or raw provider payloads that include secrets.
