# Changelog

## Unreleased — installation, Home companion, permissions and model selection

- Anthropic Pi-style `/login anthropic` behind default-off `HEARTH_ANTHROPIC_AUTH_ENABLED` (HA option fallback `anthropic_auth_enabled`). Native Pi method selection, state-bound headless copy code, private separated tokens/refresh/expiry/check/logout and pinned pi-anthropic-auth 3.4.2 OAuth compatibility. No ambient resources or debug logging. Experimental provider-terms/extra-billing caveats; no included-usage or live Claude inference claim.
- Local model endpoint provider (`provider: local`): connect an OpenAI-compatible server on your private network (Ollama, LM Studio, llama.cpp, vLLM) from the UI — enter URL, test (fingerprints the server, hides embedding and non-tool models), pick a default model — registered as a real Pi provider with no restart. Private addresses only, no scanning, no redirects; optional key stored privately. Startup reloads the saved endpoint offline.
- ChatGPT login dialog follows Pi's interactive `/login`: Pi's own method selection is relayed to the owner, then the device code or browser step. Shows token expiry (never the token) and adds **Check connection**, which resolves auth through Pi and refreshes near expiry. ChatGPT remains unaffected by the new default-off Anthropic feature flag.
- Smoother ChatGPT device code login: the method chooser lists Device code first and marks it recommended for Home Assistant/phones (Browser login kept second, noted as needing a pasted redirect URL \u2014 Pi's own option ids/labels are unchanged). The code renders large with a Copy code button (clipboard with a select-text fallback), a button-styled "Continue at OpenAI" link, one-line steps, a clearer "waiting for approval" state and a method-specific failure hint; the status endpoint now also reports the chosen login method id so the hint can be specific without ever forwarding raw provider error text.
- Official one-click My Home Assistant repository link, manual App-store/sidebar instructions and complete safe configuration example. Home mode needs no operator shell setup; the optional Code worker remains a separate installation.
- Native Home canvas (`ha_build_view`): assistant-selected structure over exact approved entities, controller-read values and atomic durable canvas/receipt with explicit refresh.
- Home permissions: Read-only (default), Ask (exact human approval) and explicitly acknowledged Full access for the configured exact light/switch policy. Unknown outcomes block autonomous reissue until human reconciliation; no automatic retry.
- Durable per-session model and thinking selector from the configured provider's local registry; Codex default `gpt-6.1-sol` with medium thinking when `model` is empty.
- Raise bounded exact-entity configuration and search pagination beyond 500, aligned with the 10,000-state bound. Defaults still deny all entities; no wildcard grant.
- Show configured entity count in Home-mode safety text without exposing entity IDs in bootstrap.
- Delete a session from its conversation header (owner-confirmed, names the session and states the stored transcript is not securely erased). Removes it from the Catalog, which frees the per-owner/total session limits and makes every session-scoped route answer `404`; refused with a distinct `409` code while the session still has an unresolved proposal, a running task, an unanswered/unplaced input, or (for a coding workspace) a paused `WorkspaceGuard`, so the installation-wide unknown-outcome barrier can never be dropped by deleting the session that holds it. Pi Durable has no API to erase the underlying conversation; the transcript stays in the private `/data` store.
- Compact phone / HA companion-app layout: the conversation keeps the screen. Home permissions and the model picker open on demand from a header **◈ mode** chip and a **Model** button, sessions become a one-row chip strip, the Home view starts collapsed, Stop shows only while a task runs, the composer auto-grows, dialogs become bottom sheets, and iOS safe areas/zoom-on-focus are handled. Short landscape screens use the same compact rules. Wide layouts are unchanged; no permission, approval or model semantics changed.

## 0.2.0 — subscription and isolated coding preview

- Matching exact Pi 1.0.1 pins; SDK 1.0.0 shrinkwrap advisory resolved without audit suppression.
- Official ChatGPT/Codex OAuth device login, state-required browser fallback, private serialized credentials/refresh and protected owner-bound UI.
- Genuine regular-Pi tools in a separate offline confined worker; explicit Home/Code sessions, no HA/model/host credentials in the worker.
- Durable unsafe coding intents and fresh-human-input guard after uncertain outcome or restart; real SIGKILL and IPC tests.
- Single trusted coding operator; worker installation/backups are separate and operator-controlled. Live account/OS/Ingress evidence is recorded separately, not implied by synthetic tests.

## 0.1.0 — experimental initial implementation

- Pi Durable 1.0.0 SQLite-backed sessions, offline faux demonstration and OpenAI API-key adapter.
- Scoped read-only HA discovery/detail, immutable light/switch proposals and separately approved actions.
- Ingress/local authentication boundaries, text-only UI, restart recovery and synthetic validation suite.

Published as a source alpha; that baseline did not establish live Supervisor deployment. See [validation](docs/validation.md).
