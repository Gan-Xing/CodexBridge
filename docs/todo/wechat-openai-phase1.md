# WeChat + Codex Phase 1 TODO

## Phase 0: Repository Bootstrap

- [x] Add architecture document
- [x] Add executable Phase 1 TODO
- [x] Add zero-dependency Node project scaffold
- [x] Add source layout for core, runtime, platforms, providers, and store

## Phase 1: Core Contracts

- [x] Define bridge session model
- [x] Define platform binding model
- [x] Define session settings model
- [x] Define platform plugin contract
- [x] Define provider plugin contract
- [x] Add session router
- [x] Add bridge session service

Acceptance:

- [x] Platform code does not own canonical session state
- [x] Provider code does not depend on platform-specific payloads
- [x] Same session can be shared by multiple platform bindings

## Phase 2: Repository Layer

- [x] Add in-memory provider profile repository
- [x] Add in-memory bridge session repository
- [x] Add in-memory platform binding repository
- [x] Add in-memory session settings repository
- [x] Test same-scope session reuse
- [x] Test multi-platform shared session binding
- [x] Test provider switch isolation

Acceptance:

- [x] Existing scope resolves the same session repeatedly
- [x] Multiple platform scopes can point to one session
- [x] Provider switch creates a new session and keeps boundaries clear

## Phase 3: Runtime Assembly

- [x] Add plugin registry
- [x] Add runtime bootstrap factory
- [x] Add placeholder platform plugins for WeChat and Telegram
- [x] Add placeholder provider plugins for OpenAI native and MiniMax via CLIProxyAPI
- [x] Add initial Codex engine adapter and Codex profile loader

Acceptance:

- [x] Core runtime can register plugins without hard-coding one platform
- [x] Core runtime can register providers without changing platform code

## Phase 4: WeChat + Codex Implementation

- [x] Implement WeChat account config loader
- [x] Implement WeChat login flow
- [x] Implement WeChat long-poll loop skeleton
- [x] Implement WeChat inbound text normalization
- [x] Implement WeChat outbound text sending skeleton
- [x] Add Codex profile loader and initial Codex engine adapter skeleton
- [x] Add a runnable WeChat bridge serve command
- [x] Wire WeChat DM scope to bridge session resolution
- [ ] Start a new Codex thread when no binding exists
- [ ] Continue the existing Codex thread when a binding already exists
- [x] Add file-backed JSON repositories for bridge state

Acceptance:

- [ ] One WeChat DM can keep talking to the same Codex thread
- [x] Restarting the bridge preserves the binding when file-backed repositories are used
- [x] OpenAI remains the default Codex provider profile

## Phase 5: Command Surface

- [x] Implement `/status`
- [x] Implement `/new`
- [x] Implement `/threads`
- [x] Implement `/open`
- [ ] Implement `/interrupt`

Acceptance:

- [x] Commands operate on bridge session state, not raw platform state
- [ ] Commands work in WeChat DM for the default provider profile

## Phase 6: Telegram Re-entry

- [ ] Implement Telegram platform plugin on top of the same core contracts
- [ ] Allow Telegram scope to bind to an existing bridge session
- [ ] Verify WeChat and Telegram can share one Codex-backed bridge session under the same provider profile

Acceptance:

- [ ] Telegram integration does not require redesigning the core
- [ ] Same provider profile and same Codex thread can be continued from both platforms

## Phase 7: MiniMax Provider Re-entry

- [ ] Add MiniMax provider profile configuration
- [ ] Add MiniMax provider adapter via CLIProxyAPI
- [ ] Implement provider switching as new-session creation

Acceptance:

- [ ] New provider does not require platform code changes
- [ ] OpenAI and MiniMax threads do not mix
- [ ] Provider switching has explicit and clear session boundaries
