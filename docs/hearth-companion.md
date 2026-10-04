# Hearth companion — native functionality on Pi Durable

## Product direction

Muse is inspiration, not a dependency. The owner explicitly rejected Muse integration: no Muse SDK, account, token, pairing, cloud bridge or installer. Build original Hearth capabilities directly, using the existing protected model provider and **genuine pinned Pi Durable1.0.1** underneath. Pixel/companion art is a presentation choice, not the agent's intelligence. This direction supersedes the Muse-bridge proposal in the separate throwaway UI prototype.

The goal is a useful home companion, not just a chat box or a visually similar avatar:

1. **Understand and explain** approved home/device state with real scoped tools and evidence.
2. **Build useful interfaces** from conversation: named status views, room/device groups and contextual follow-up questions rather than hand-maintained dashboard YAML.
3. **Carry work forward** through durable inputs, tool tasks, committed documents, reconnect and recovery; show what is known, stale, failed or waiting for a person.
4. **Remember deliberately**: future owner-approved preferences and household context must be inspectable, editable and forgettable; a saved transcript is not proof of a long-term memory feature.
5. **Take bounded initiative**: future opt-in monitors/briefings/reminders need exact sources, frequency, budget, expiry/cancellation and replay policy. No secretly enabled polling, notifications or physical routines.
6. **Act carefully**: Home Read-only / Ask / explicitly acknowledged Full access, immutable action receipts, exact service scope and visible receipts/unknown outcomes; never equate an API acknowledgment with physical verification.
7. **Create safely**: later structured interactive mini-apps and explicit handoff to the confined coding worker, not arbitrary model HTML, host-shell privileges or HA credentials inside generated programs.

## First functional slice: assistant-built Home canvas

Ask Hearth: “Build me a status view of the entities you can actually read.”

The Home agent discovers exact approved IDs, then calls `ha_build_view` with a bounded title and named sections referring only to those IDs. The controller—not the model—reads HA state and selected attributes. After all reads succeed it commits one timestamped canvas document through Pi Durable. The authenticated browser renders this committed state next to the existing conversation and action reviews. Reload/SSE reconnect hydrates the saved view without executing a service or silently refreshing readings. A human refresh request creates a normal durable Home input and makes fresh scoped reads.

The model can choose structure/titles; it cannot supply authoritative values, URLs, JavaScript/HTML, service buttons or authorization grants. Partial/failed reads leave the prior saved canvas intact. Unauthorized IDs are rejected before any HA fetch. Duplicate task recovery reuses an already-committed canvas; before-commit recovery may repeat safe GETs. The canvas is per-owner/per-conversation, not shared household or cross-user memory. Readings have explicit timestamps and are historical observations, not continuous telemetry or physical-effect verification. Code sessions do not receive this Home capability.

Architecture: authenticated HA App/browser → existing `Runtime`/`Harness` → `pi.generation`/`pi.tool` → fixed HA GETs → `api.commit`/`defineDoc` → existing snapshot/SSE → safe DOM rendering. SQLite retains exclusive single-writer WAL/FULL ownership; no second chat agent, substitute JSON history store or sidecar AI runtime.

## Source validation

On Node24.21.0, the full branch check passed31tests plus formatting, typecheck, build, package assertions and secret scan. New coverage drives the real pinned Harness with an offline faux model/fake HA: actual tool dispatch, controller-only values, all-or-nothing failure, unauthorized/duplicate/oversized/extra-field denial before fetch, late secret sanitization, scope revocation, task-receipt non-reapplication, per-owner/Code isolation, authenticated snapshot/document-only SSE and text-safe rendering. A real child process is SIGKILLed before and after the canvas commit: only the pre-commit case repeats safe reads; the post-commit case hydrates its receipt with no new GET. Ordinary input deduplication remains intact.

A separate read-only code review reported no concrete issues, subject to the full gates. It is not an external security audit. No live production-model canvas turn, updated App deployment, mobile canvas/browser interaction, backup restore/full-host power-loss or general compatibility was verified for this new slice. DOM tests are not physical mobile UI verification. Previously verified Home/worker paths remain separate evidence.

## Demo and limits

The meaningful demo is request → actual tool execution → grounded generated view → explicit refresh → reload/process reopen with the same saved canvas. Test fakes prove source behavior, not live household facts or production model decisions. The current installed App remains0.2.0 with only `sun.sun` and service actions off; broader devices/rooms need separate exact read-scope approval. No source work here approves a release, push, deployment, App/Core restart, device write or extra worker privilege.

Voice, proactive monitors, reminders, long-term preference memory, arbitrary mini-apps and generic device/gadget support are future milestones—not implemented or enabled by the first canvas slice.
