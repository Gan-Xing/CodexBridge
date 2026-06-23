# CodexProvider Recipes

These recipes describe how a host app should wire `@codex-provider/core` without depending on CodexBridge internals.

Historical names under `@codexbridge/codex-provider-relay` and `CodexProviderRelay*` remain as deprecated aliases during the stabilization cycle.

## Mixed OpenRouter Runtime

Use `profileMode: "mixed"` when Codex should talk to a local Responses adapter while the relay calls an upstream Chat Completions API.

```ts
const runtime = new CodexProviderRuntime({
  apiKey: process.env.OPENROUTER_API_KEY!,
  upstreamBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "deepseek/deepseek-chat",
  providerLabel: "openrouter",
  profileMode: "mixed",
  toolStrategy: "codex-local-first",
});
```

## Mixed Requesty Runtime

Requesty is an OpenAI-compatible LLM gateway. Wire it exactly like OpenRouter, swapping the base URL, provider label, and API key env var. Models use `provider/model` naming (for example `openai/gpt-4o-mini`).

```ts
const runtime = new CodexProviderRuntime({
  apiKey: process.env.REQUESTY_API_KEY!,
  upstreamBaseUrl: "https://router.requesty.ai/v1",
  defaultModel: "openai/gpt-4o-mini",
  providerLabel: "requesty",
  profileMode: "mixed",
  toolStrategy: "codex-local-first",
});
```

## Relay-Emulated Hosted Tools

Relay-emulated tools must be declared and registered.

```ts
hostedTools: [{ name: "web_search", mode: "relay-emulated" }],
hostedToolExecutors: {
  web_search: createCodexProviderWebSearchExecutor({
    provider: "tavily",
    apiKey: process.env.TAVILY_API_KEY!,
  }),
}
```

The relay then exposes a function tool to Chat Completions upstreams, executes the host-provided executor, appends the tool output, and continues the model loop.

## Local Vector File Search

Use explicit roots and an explicit embedding provider.

```ts
const fileSearch = createCodexProviderFileSearchExecutor({
  sources: [{
    type: "local-vector",
    roots: [workspaceRoot],
    embeddingProvider: createCodexProviderEmbeddingsApiProvider({
      apiKey: process.env.EMBEDDINGS_API_KEY,
      endpoint: process.env.EMBEDDINGS_API_ENDPOINT,
      model: process.env.EMBEDDINGS_MODEL,
    }),
  }],
});
```

The package does not scan the process working directory implicitly. Hosts must decide which roots are safe.

## Unsafe Tool Policy

`code_interpreter`, `computer`, shell-like tools, and any real environment-control surface require a host-owned executor and safety policy. The relay package only defines contracts and output normalization.

## Standalone Server Env

Use the new prefix for new deployments:

```bash
CODEX_PROVIDER_RELAY_CAPABILITY_PRESET=openrouter
CODEX_PROVIDER_RELAY_API_KEY=...
CODEX_PROVIDER_RELAY_MODEL=deepseek/deepseek-chat
CODEX_PROVIDER_RELAY_TRACE=stderr-json
codex-provider-server
```

The same shape works for the `requesty` preset (base `https://router.requesty.ai/v1`):

```bash
CODEX_PROVIDER_RELAY_CAPABILITY_PRESET=requesty
CODEX_PROVIDER_RELAY_API_KEY=...
CODEX_PROVIDER_RELAY_MODEL=openai/gpt-4o-mini
CODEX_PROVIDER_RELAY_TRACE=stderr-json
codex-provider-server
```

Legacy `CODEX_GATEWAY_*` variables remain supported for compatibility.

## Release Validation

Before publishing or wiring a new host application, review:

- [Live smoke recipes](LIVE_SMOKE_RECIPES.md)
- [Unsafe tool security](UNSAFE_TOOL_SECURITY.md)
- [Release readiness](RELEASE_READINESS.md)
