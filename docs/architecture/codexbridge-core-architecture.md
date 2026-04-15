# CodexBridge Core Architecture

## Goal

`CodexBridge` is a `platform plugins + Codex engine adapter + bridge core` project.

The first shipped path is:

- platform: `WeChat`
- engine: `Codex`
- default Codex provider profile: `openai-default`

The architecture must already be ready for:

- platform: `Telegram`
- Codex provider profile: `MiniMax via CLIProxyAPI`

## Non-goals for Phase 1

- No Hermes/OpenClaw runtime embedding
- No shared poller with another WeChat gateway
- No group chat support
- No rich card UI parity with Telegram
- No multi-provider mixing inside one real Codex thread

## Core Design Rules

1. Platform is not the source of truth for conversation state.
2. The Codex engine adapter is not allowed to leak platform-specific structures into the core.
3. A real Codex session is identified by:
   - `provider_profile_id`
   - `codex_thread_id`
4. Multiple platform scopes may point to the same bridge session.
5. Provider profile switching must create a new bridge session instead of reusing a previous provider thread.

## Canonical Session Model

For the first implementation, the core unit is `bridge_session`.

A `bridge_session` represents one Codex-backed thread under one provider profile:

- `provider_profile_id`
- `codex_thread_id`
- `cwd`
- `title`

Platform scopes do not own thread state. They only bind to a bridge session.

Examples:

- `weixin:user_123 -> session_openai_a`
- `telegram:-100xx::1417 -> session_openai_a`

If both bindings point to the same session, both platforms are operating the same Codex thread.

## Data Model

### `provider_profiles`

Stores configured Codex provider profiles.

Suggested fields:

- `id`
- `provider_kind`
- `display_name`
- `config`
- `created_at`
- `updated_at`

### `bridge_sessions`

Stores the canonical provider-thread mapping.

Suggested fields:

- `id`
- `provider_profile_id`
- `codex_thread_id`
- `cwd`
- `title`
- `created_at`
- `updated_at`

### `platform_bindings`

Maps a platform scope to a bridge session.

Suggested fields:

- `platform`
- `external_scope_id`
- `bridge_session_id`
- `updated_at`

### `session_settings`

Stores session-level settings instead of platform-level settings.

Suggested fields:

- `bridge_session_id`
- `model`
- `reasoning_effort`
- `service_tier`
- `locale`
- `metadata`
- `updated_at`

## Message Flow

### Existing binding

1. Platform adapter receives a message.
2. Core resolves `platform + external_scope_id`.
3. Binding returns `bridge_session_id`.
4. Session returns `provider_profile_id + codex_thread_id`.
5. The Codex engine adapter continues the Codex thread.
6. The output is projected back to the platform.

### First message without binding

1. Platform adapter receives a message.
2. No binding exists for this scope.
3. Core creates a new bridge session using the default provider profile.
4. The Codex engine adapter starts a new Codex thread.
5. Core saves the new session and the platform binding.
6. The response comes back through the same route.

### Provider profile switch

1. Platform requests a provider change.
2. Core does not mutate the existing bridge session.
3. Core creates a new session for the target provider profile.
4. The platform binding is moved to the new session.
5. The old session remains available for explicit reopening if needed.

## Plugin Contracts

### Platform plugin

Platform plugins must be replaceable and isolated.

Required responsibilities:

- normalize inbound events
- identify external scope
- send messages
- edit messages if supported
- emit typing state if supported
- download attachments if supported

They must not:

- decide provider profile routing
- store canonical thread state
- directly manipulate Codex runtime internals

### Codex engine adapter

The current code still uses the legacy `provider plugin` naming internally, but the runtime meaning is:

- one `codex` engine adapter
- many Codex provider profiles

The Codex engine adapter wraps the Codex app-server runtime.

Required responsibilities:

- list models
- start thread
- resume thread
- start turn
- interrupt turn
- list threads
- read thread

They must not:

- depend on Telegram/WeChat message shapes
- own platform binding state

## Phase 1 Boundary

The first real implementation is intentionally narrow:

- personal WeChat only
- single account
- single poller
- DM only
- Codex only
- default provider profile only
- text only
- minimal slash-style commands

This keeps the first bridge real and debuggable.

## Telegram Re-entry

Telegram should later be added as another platform plugin.

The target behavior is:

- Telegram scope can bind to the same bridge session as WeChat
- both platforms can continue the same Codex thread when the provider profile is the same
- no Telegram-specific state should be required in the core for that to work

## MiniMax Re-entry

MiniMax should later be added as a second Codex provider profile.

Important rule:

- it must not reuse the OpenAI profile's real Codex thread id
- switching to MiniMax creates a new bridge session
- the platform binding moves, but the provider boundary stays clean

## Current Implementation Strategy

The first repository milestone is not a fake “WeChat connected” demo.

It is:

1. architecture documents in repo
2. core repositories and routing primitives
3. platform and Codex engine adapter contracts
4. zero-dependency in-memory implementations for testing the model
5. bootstrap code that future WeChat/Codex code can attach to without redesign
