# CodexBridge Automation Subsystem

This document describes CodexBridge's `/auto` subsystem as a scheduler-owned
host capability. It is intentionally separate from Mission Control.

## Boundary

`/auto` is responsible for:

- automation job drafts and confirmation
- schedule parsing and persistence
- claim/defer/pause/resume/delete lifecycle
- one-shot scheduled execution against the bound session
- delivering results back through the normal host delivery path

`/auto` is not a Mission Control surface and `AutomationJob` is not a mission
record.

## Current Model

The scheduler owns:

- `AutomationJobService`
- `AutomationJob` persistence
- due-job sweeps
- busy-scope deferral
- rebound bridge-session updates
- result preview / error / delivered-at bookkeeping

When a job fires, the runtime:

1. claims the due `AutomationJob`
2. builds an `InboundTextEvent` from `job.prompt`
3. carries `overrideBridgeSessionId`, `automationJobId`, and `automationMode`
   in metadata
4. runs the event through the normal inbound pipeline
5. writes back any rebound session id
6. stores the scheduler-owned completion fields

## Recorded Pre-`a22b496` Implementation

Commit `a22b496` introduced the automation-to-Mission-Control binding that has
now been removed. Before that commit, `/auto` used the same scheduler-owned
one-shot flow described above:

1. `WeixinBridgeRuntime.runAutomationSweepInternal()` claimed due
   `AutomationJob` records.
2. `WeixinBridgeRuntime.runAutomationJob(job)` built an `InboundTextEvent`
   whose `text` was `job.prompt`.
3. The event metadata carried:
   - `overrideBridgeSessionId`
   - `automationJobId`
   - `automationMode`
4. The runtime executed the event through
   `processInboundEventWithOptions(...)`.
5. If the response rebound to a different bridge session, the runtime wrote the
   new `bridgeSessionId` back onto the `AutomationJob`.
6. The runtime persisted only scheduler-owned completion fields such as:
   - `resultPreview`
   - `error`
   - `deliveredAt`
7. Failures sent the normal automation error delivery message back through the
   host.

There was no `MissionRuntime`, no mission/attempt/event/workpad persistence on
the automation path, and no `AutomationJob == Mission` identity coupling.

## Current Plan

1. Keep `AutomationJobService` as the sole owner of schedule, claim/defer, and
   delivery bookkeeping.
2. Keep `/auto` on the restored one-shot execution path by default.
3. Keep automation persistence free of Mission Control compatibility fields.
4. If a future scheduled workflow truly needs Mission Control, introduce an
   explicit scheduler-to-mission trigger adapter that:
   - creates a separate mission run or generation
   - stores only a mission reference on the scheduler side
   - never treats `AutomationJob` as the mission record itself
