# Hearth Pi

### A durable AI agent for Home Assistant

![Original Hearth Pi mark](hearth_pi/icon.png)

**Independent community App · 0.2.0 · experimental.** Not an official Home Assistant or Pi product. The pinned Pi 1.0.1 APIs are experimental. This is a technical preview, not a production recommendation or external security audit.

[![Checks and native container smoke](https://github.com/cosmyo/ha-pi-durable/actions/workflows/check.yml/badge.svg)](https://github.com/cosmyo/ha-pi-durable/actions/workflows/check.yml)

![Hearth Pi offline demonstration and reload](docs/images/offline-demo.gif)

_The original 0.1.0 GIF is a real browser capture with synthetic offline data and history restored after reload. No model inference or HA action occurred; it does not depict the newer subscription/workspace features._

- **Continuity, not just history.** Genuine pinned Pi Durable commits admitted inputs, task checkpoints, transcripts and documents to SQLite with `synchronous=FULL`. One writer owns each store. Reconnect to committed state.
- **Home mode.** Explicitly scoped HA reads, service discovery and immutable light/switch proposals. Empty scope denies reads. Actions are disabled by default; enabling them still requires exact human approval. No Home-mode shell, filesystem, configuration, Docker or Supervisor-admin tools.
- **Code mode, separately confined.** Genuine Pi coding-agent `read`, `edit`, `write` and `bash` tools run in an optional **separate** non-root, no-network worker container. It has its own files—not HA configuration, controller `/data`, SSH/Docker access or HA/provider credentials. Code sessions do not receive HA tools. This preview supports one trusted coding operator.
- **ChatGPT subscription support.** Official Pi `openai-codex` OAuth, with headless device-code login and a state-checked browser redirect fallback. Tokens stay in private controller storage. OpenAI API-key mode is separate; a ChatGPT subscription does **not** make API-key calls free.
- **Uncertain effects stay uncertain.** Interrupted coding calls are not replayed; an interrupted workspace turn requires a fresh human input before more tool execution. HA dispatches persist intent before one attempt; interrupted dispatch is unknown and never automatically retried. A service receipt is not physical-device verification.

For ordinary voice control, consider [official Assist](https://www.home-assistant.io/voice_control/) first. Hearth Pi explores durable execution and explicit boundaries, not administrative autonomy. We do not promise exactly-once physical effects, local inference or power-loss proof.

## Try without AI credentials

Use **Node 24.21.0 LTS**, npm and a clean checkout:

```sh
npm ci
npm --prefix hearth_pi ci
npm run check
# In Bash; choose a private 24+ character password, not an API key:
read -r -s -p 'Local password: ' HEARTH_LOCAL_PASSWORD; printf '\n'
export HEARTH_LOCAL_PASSWORD
HEARTH_MODE=local HEARTH_PROVIDER=offline npm --prefix hearth_pi start
```

Open `http://127.0.0.1:8099/`; username **hearth**, password as entered. The real durable harness uses an explicitly offline faux provider, not an LLM. Restart and reload to see committed history. Local mode binds loopback, rejects root and never trusts Ingress identity headers. Local state stays in ignored `hearth_pi/.local/`.

## Home Assistant installation

Public source repository: **https://github.com/cosmyo/ha-pi-durable**. Add it to the HA App store only on an authorized test installation and follow [App installation/options](hearth_pi/DOCS.md).

The complete App build context is `hearth_pi/`. It requests Ingress, HA's scoped API proxy and private `/data`, plus **only its own** `addon_config` bridge directory. No public ports, HA Core configuration mounts, Supervisor-admin/auth/Docker APIs or added privileges. The optional coding worker requires a trusted operator to create a separately constrained container; the App/agent cannot create Docker containers. [Workspace installation and boundaries](docs/workspace.md).

All authorization/action/entity lists start empty; coding is disabled. Configure exact trusted operator IDs and the HTTPS origin used by your browser. Sidebar admin visibility is not server authorization or proof of current HA role membership. Authorized IDs are trusted App operators, including access to its shared provider setup; don't add untrusted household/guest accounts.

## Providers and privacy

- `offline`: demonstration only; no inference.
- `openai`: official OpenAI API-key endpoint; separate API billing.
- `openai-codex`: ChatGPT subscription OAuth through Pi ModelRuntime. Sign in from **ChatGPT login** in the App. Account eligibility, model availability and provider limits still apply. Never put tokens or redirect URLs in chat/issues/recordings.

Explicit protected storage replaces Pi's default credential/resource discovery. No personal `~/.pi` configuration, extensions or credentials are copied into the App or worker. Custom/local endpoints, voice integration and general Pi extension/MCP loading are not supported in this preview.

When an online provider is used, input, conversation context, tool declarations and selected tool output go to that provider. That includes coding files you explicitly read. Requests use `store:false`; provider retention/account policies still apply. Reported token counts are **not a bill**. There is no App telemetry. [Security and threat model](docs/security.md).

## Evidence and limitations

`npm run check` covers typechecking, real-harness/SIGKILL recovery, request deduplication, API/auth/approval tests, synthetic provider tests, genuine Pi tools over authenticated IPC, DOM rendering, production compilation, package validation and selected secret patterns. Native amd64/aarch64 CI includes separate controller and confined-worker Docker gates. A badge or green smoke test does not prove a real Supervisor deployment, a live subscription login or a mobile iframe.

[Validation evidence and remaining gates](docs/validation.md) separates verified paths from unfinished work. Backup restoration, physical power loss, real mobile behavior and broad performance remain separate tests. Model work may be repeated after recovery and consume account allowance/cost; physical and coding mutations do not automatically replay. Workspace files need a separate backup; an App database restore does not undo file/device effects.

See [architecture](docs/architecture.md), [workspace](docs/workspace.md), [research](docs/research.md), [roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md). Application code/artwork are original and MIT-licensed; [third-party notes](docs/third-party.md) describe dependencies.
