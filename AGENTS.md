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
- Read-only HA tools are the default. Service mutations require explicit exact configuration. Home permissions default to Read-only when writes are disabled, otherwise Ask (exact immutable human approval). Explicit owner-acknowledged Full access may auto-approve only the supported light/switch actions within its revision/policy-bound grant; it grants no host/admin/Code privileges. Interrupted writes are never retried.
- Never automatically retry an interrupted external mutation. An unknown outcome must remain unknown until a human resolves it.
- Ingress authentication must be enforced at the server boundary, not merely trusted because an identity header is present. Local development must require explicit authentication and bind to loopback.
- Never offer shell/filesystem/configuration-write/Supervisor-admin/Docker tools in the HA controller or Home conversations. Optional regular Pi coding tools require a separate verified offline non-root confined worker, no controller/HA/credential mounts or network, explicit Code sessions and the unknown-outcome/no-reissue guard. No same-UID/process shortcut.
- Provider credentials and Supervisor tokens must not enter prompts, transcripts, API responses, browser bundles, or logs.
- Treat entity attributes, tool output and model output as untrusted data. Render text safely and validate all HTTP and tool arguments.

## Completion criteria

Run type checks, automated tests and production build. Test the actual durable harness with an offline provider, restart recovery, HA API fakes, authentication and service-action approval failures. Document untested deployment paths and experimental upstream limitations honestly. Keep dependencies and lockfiles reproducible, and maintain public installation, security and contribution documentation.
