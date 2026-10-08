# Hearth Pi contributor guide

Hearth Pi is an independent, experimental Home Assistant App built on Pi Durable. This repository is intended to be public.

## Boundaries

- Work only in this repository. Do not deploy to live Home Assistant systems, create remote repositories, push, or publish without explicit approval.
- Never copy credentials, personal configuration, private infrastructure addresses, SSH keys, or existing agent transcripts into the repository.
- Use synthetic fixtures and `.example` domains in examples. Keep runtime data and local settings out of Git.
- Do not copy community implementation code without verifying its license and retaining required attribution. Prefer original implementations of common architectural ideas.

## Engineering principles

- Use the real, version-pinned `@earendil-works/pi-durable` API; do not substitute regular Pi or simulate durability with saved chat history.
- Verify current Pi APIs in official documentation and installed type declarations before using them. Read relevant Markdown documentation fully and follow related references.
- One writer owns each durable store. Persist admitted input before acknowledgement, hydrate committed state on reconnect, and resume unfinished work on startup.
- Two access modes, chosen only in the App configuration (`access_mode`), never by the UI, a model or a suggestion:
  - **Scoped** (default for public installs): read-only HA tools by default; service mutations require explicit exact configuration (`allowed_entities`, `allowed_services`). Explicit owner-acknowledged Full access may auto-approve only the supported light/switch actions within its revision/policy-bound grant.
  - **Admin** (owner opt-in): Hearth may read every entity and use Home Assistant admin capabilities (any service call, automation/script/scene/helper configuration, registries, reloads/restarts) and the Supervisor API (add-ons, backups, logs, host/OS/core info and control) as the owner would. Every mutation is still a durable, exact proposal with a receipt that goes through Home permissions and the action risk classifier below.
- Home permissions default to Read-only when writes are disabled, otherwise Ask (exact immutable human approval). Full access auto-approves only what the risk classifier allows; it never bypasses the always-ask tier. Interrupted writes are never retried.
- **Action risk classifier.** Every proposed mutation is classified before dispatch by deterministic controller rules into low / medium / high / critical (e.g. a light is low; climate or a config write is medium; locks, alarms, garage/cover openings, Supervisor add-on install/stop and HA restart are high; host reboot/shutdown, backup restore/delete, add-on uninstall, OS/Supervisor/Core updates and anything that changes, stops or removes Hearth itself are critical). An optional model judge (a separate, tool-less call that sees only the owner's latest request and the exact proposed action, never tool output) may only escalate a risk level or flag an intent mismatch; it can never lower a level or approve anything. Judge errors or timeouts fail closed to Ask. In Full access, low (and medium when the judge agrees) may auto-run; high and critical always require exact human approval, and critical additionally requires an explicit confirmation step. Classification and the deciding rule are recorded on the receipt and shown on the approval card.
- No host shell, host filesystem, Docker socket or privileged container access in the HA controller or Home conversations, in either mode; Supervisor/HA APIs are the only admin path. Admin mode must never expose Supervisor or HA tokens to the model, browser or logs.
- Never automatically retry an interrupted external mutation. An unknown outcome must remain unknown until a human resolves it.
- Ingress authentication must be enforced at the server boundary, not merely trusted because an identity header is present. Local development must require explicit authentication and bind to loopback.
- In Scoped mode never offer configuration-write or Supervisor-admin tools. In either mode never offer shell/filesystem/Docker tools in the HA controller or Home conversations. Optional regular Pi coding tools require a separate verified offline non-root confined worker, no controller/HA/credential mounts or network, explicit Code sessions and the unknown-outcome/no-reissue guard. No same-UID/process shortcut.
- Provider credentials and Supervisor tokens must not enter prompts, transcripts, API responses, browser bundles, or logs.
- Treat entity attributes, tool output and model output as untrusted data. Render text safely and validate all HTTP and tool arguments.

## Completion criteria

Run type checks, automated tests and production build. Test the actual durable harness with an offline provider, restart recovery, HA API fakes, authentication and service-action approval failures. Document untested deployment paths and experimental upstream limitations honestly. Keep dependencies and lockfiles reproducible, and maintain public installation, security and contribution documentation.
