# Changelog

## Unreleased — installation, Home companion, permissions and model selection

- Local model endpoint provider (`provider: local`): connect an OpenAI-compatible server on your private network (Ollama, LM Studio, llama.cpp, vLLM) from the UI — enter URL, test (fingerprints the server, hides embedding and non-tool models), pick a default model — registered as a real Pi provider with no restart. Private addresses only, no scanning, no redirects; optional key stored privately. Startup reloads the saved endpoint offline.
- ChatGPT login dialog follows Pi's interactive `/login`: Pi's own method selection is relayed to the owner, then the device code or browser step. Shows token expiry (never the token) and adds **Check connection**, which resolves auth through Pi and refreshes near expiry. Claude subscription OAuth is deliberately not offered (Anthropic terms).
- Official one-click My Home Assistant repository link, manual App-store/sidebar instructions and complete safe configuration example. Home mode needs no operator shell setup; the optional Code worker remains a separate installation.
- Native Home canvas (`ha_build_view`): assistant-selected structure over exact approved entities, controller-read values and atomic durable canvas/receipt with explicit refresh.
- Home permissions: Read-only (default), Ask (exact human approval) and explicitly acknowledged Full access for the configured exact light/switch policy. Unknown outcomes block autonomous reissue until human reconciliation; no automatic retry.
- Durable per-session model and thinking selector from the configured provider's local registry; Codex default `gpt-6.1-sol` with medium thinking when `model` is empty.
- Raise bounded exact-entity configuration and search pagination beyond 500, aligned with the 10,000-state bound. Defaults still deny all entities; no wildcard grant.
- Show configured entity count in Home-mode safety text without exposing entity IDs in bootstrap.

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
