# Contributing

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [security](docs/security.md) and [validation](docs/validation.md) before proposing changes. This is an independent experimental App; keep patches small and preserve its fail-closed boundaries. No live-system testing, remote creation, publishing or dependency/code copying without authorization.

Use Node 24.21.0. From a clean checkout run `npm ci`, `npm --prefix hearth_pi ci`, then `npm run check`. Run `npm run format` after edits; the pinned formatter is checked by the validation gate. Add synthetic tests for changed behavior (especially admission/recovery, peer/owner checks and mutation outcomes). CI configuration does not establish that any remote run passed. Docker/container and real Supervisor testing require a separate authorized isolated environment.

Do not commit secrets, personal options, runtime databases, transcripts or real HA snapshots. Use `.example` domains and synthetic identities. Do not add generic network, shell, filesystem, configuration or administrative agent tools; changes to permissions, provider auth and action dispatch need threat-model review. Confirm licenses and retain notices before importing third-party code or artwork; ideas are not a license to copy. Include a concise rationale, tests, deployment limitations and user-facing docs with any contribution.
