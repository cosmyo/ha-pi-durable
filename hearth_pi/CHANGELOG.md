# App changelog

## Unreleased — installation, Home companion, permissions and model selection

Apps on demand (source slice): Hearth can build small household apps from a Home chat as validated declarative HAS/1 specs. Every value is read by Hearth with an as-of time; checklist ticks, counters and notes are kept separately from versions; toggles use Home permissions and are never retried after an unknown outcome. Open them from **Apps** in the drawer or pin them to empty chats.

Default-off Anthropic `/login` feature flag with native Pi headless copy-code auth, private per-provider tokens and pinned pi-anthropic-auth 3.4.2 transport compatibility. HA option fallback allows deliberate installation opt-in without changing provider/scope/permissions. Experimental third-party subscription terms/extra-billing warnings; not a live Claude inference claim.

One-click repository link and App-store/sidebar setup instructions. Native Home canvas over exact approved entities; Read-only (default) / Ask / explicitly acknowledged Full access Home permissions for exact light/switch policies; durable per-session model/thinking selector; a UI-connected private-network local model endpoint (`provider: local`); ChatGPT login follows Pi's interactive `/login` steps with token expiry and **Check connection**. Bounded exact-entity scopes and pagination support larger homes. A compact phone/companion-app layout keeps the conversation on screen, with Home permissions and model settings opened on demand. A session can now be deleted from its conversation header after owner confirmation; it is removed from the list and session limits and its routes answer 404, but deletion is refused while an action proposal, running task, unanswered input or paused coding workspace is still unresolved, and the stored transcript itself is not securely erased. Empty scope still denies all, service actions remain disabled by default, and Code-worker provisioning is still separate. The App version remains 0.2.0 until a tagged release.

## 0.2.0 — experimental subscription/coding preview

ChatGPT/Codex OAuth through official Pi 1.0.1 with private credential storage/headless login; separate constrained no-network regular-Pi workspace, explicit Home/Code scope and no automatic coding replay/reissue. Coding is disabled by default and requires an externally installed worker and exactly one trusted operator. No Core configuration/admin privileges. See DOCS and validation for human-login/target-system evidence and limitations.

## 0.1.0 — experimental initial implementation

Initial Ingress App source: SQLite-backed Pi Durable sessions, scoped HA reads, optional reviewed light/switch actions, offline demonstration and OpenAI API-key mode. Not a published image or tested Supervisor deployment. See [validation](../docs/validation.md).
