# Installation and configuration (experimental 0.2.0)

Use an **authorized test Home Assistant installation**, with a backup/rollback plan. Public App repository: `https://github.com/cosmyo/ha-pi-durable`. Add it under **Settings → Apps → App store → Repositories**, then install **Hearth Pi**, configure before starting, and open its Web UI. Older HA versions call Apps Add-ons. A local build is also possible by copying the complete `hearth_pi/` directory to `/addons/hearth_pi`. See [validation](../docs/validation.md) for actual evidence—not a blanket deployment/compatibility claim.

## Required options and trust

- `authorized_user_ids`: explicit trusted HA operator IDs. `[]` denies everyone. Server identity requires the documented Ingress socket peer and one `X-Remote-User-Id`; sidebar admin visibility is not authentication or proof of current role. Authorized operators may use/setup/remove the installation's shared provider credential. Do not add untrusted/guest users.
- `public_origin`: exact external HTTPS origin, no path/trailing slash, e.g. `https://home.example`. Needed for Origin/CSRF and iframe policy. Alternative origins are not implicitly accepted.
- `allowed_entities`: up to 10,000 exact entity IDs for Home reads and optional supported actions; no wildcards/all-future scope. Search pages contain twenty items. Empty denies all. Scope filters output, not the broad underlying HA token or states response processed in memory.
- `provider`: `offline`, `openai`, or `openai-codex`. Offline is a faux response, not local inference. Online conversations and selected HA/coding output go to the provider.
- **Updated requested default:** `openai-codex` new sessions use `gpt-6.1-sol` with **medium thinking** when `model` is empty. An explicit `model` option remains the operator's model default (the operator must set it to `gpt-6.1-sol` if already configured differently); Codex new-session thinking defaults to medium. API-key mode defaults to `gpt-4.1-mini` / off and offline to faux / off. The selected model must be in the pinned provider catalog; provider account limits apply. This changes no existing session's explicitly committed model/thinking choice and never rewrites admitted work.
- `openai_api_key`: used only for `openai` API-key mode. Server-side secret; options/backups are sensitive. ChatGPT subscription access does not make this API billing free.
- `service_actions_enabled`: false by default. Optional `allowed_services` contains only `light.turn_on`, `light.turn_off`, `switch.turn_on`, `switch.turn_off`, with exact allowed entities. **Home permissions** defaults to Read-only with writes disabled, otherwise Ask: the model proposes and the human approves the immutable entity/data/hash once. The authenticated owner may explicitly acknowledge Full access / auto-approve for only these configured exact actions (optional brightness 0-255 for light.turn_on). This is not all HA services or host/admin access; Code is unchanged and separately confined. No indirect area/device/group selectors. An HTTP receipt is not device verification.
- `workspace_enabled`: false by default. True requires exactly one trusted operator and a **separate confined worker** installed by the trusted host operator; it does not create a container or expose Docker. [Workspace guide](../docs/workspace.md).

## Session model and thinking

The authenticated session picker lists only chat models from the already configured provider's local in-process Pi Models registry. It performs no network catalog refresh and does not prove account entitlement. Choose model and thinking, then press **Apply model and thinking**; merely opening a session, selecting a choice, restarting or deploying never applies a draft. Actual committed session model and thinking are shown beside the picker and hydrated from snapshots/SSE. Applying persists both in the conversation's durable `pi.agent` document; the next human input uses them without an App restart. Running/admitted inputs, unresolved actions, and interrupted Code continuations cannot be switched; stale revisions fail and must be reviewed anew. Transcripts, usage, Home permission grants/policy and canvas are unchanged. New sessions receive the operator's configured model (Codex default `gpt-6.1-sol`) and medium thinking; old sessions retain their committed choice until explicitly applied. Switching does not change provider login or grant additional permissions.

## ChatGPT subscription login

1. Select `provider: openai-codex`; leave `model` empty or choose an appropriate catalog model. Restart **only this App** after option changes.
2. Open **ChatGPT login → Sign in with ChatGPT**. Device-code mode is recommended for remote HA. Complete the login/consent in your own OpenAI browser session; account eligibility and provider limits apply. Device-code login may need enabling in OpenAI's account security settings.
3. Browser fallback uses the official Pi PKCE flow. If localhost:1455 cannot reach HA, paste the **complete final redirect URL with code and state** into the protected password field, not chat. The official flow verifies state. No callback port is publicly exposed.
4. Wait for **Subscription connected**. Access/refresh tokens stay in private controller `/data`, never in browser responses, model context or coding storage. Login state is owner-bound, temporary and cancellable. No personal Pi credentials/resources are automatically imported.
5. Local sign-out removes this App's credential; it does not revoke the OpenAI account or retroactively undo requests already sent. Backups containing credentials must be protected.

OAuth is an account authorization step performed by the human, not a model tool. Never share codes, redirect URLs, tokens, options or SQLite in issues/videos. A synthetic test is not a successful live login.

## Privileges, state and rollback

Ingress only, no host ports, HA Core configuration mounts or Supervisor/admin/auth/Docker API. `/workspace_link` is this App's own `addon_config` mapping, only for worker IPC—not HA Core `/config`. HA's token is broad; the App's fixed tools enforce narrower policy. Code mode has no HA tools; its worker has no HA/model network or credentials.

## Home permissions (unreleased source slice)

Use the Home permissions selector to choose Read-only, Ask or Full access. Full acknowledgement binds to the displayed exact policy fingerprint, revision, schema and owner; settings persist in the existing durable store, not browser storage. New Full inputs may execute supported requests without per-action prompts. Running/legacy inputs cannot acquire Full, and choosing Full never executes old Ask proposals. Exact scope/service or schema changes invalidate Full; changing the policy back does not restore the grant.

Emergency Read-only stays available during work. It invalidates pending actions and promptly prevents/cancels dispatch; it cannot undo an already attempted effect. Receipts show human/automatic authorization, revision and accepted versus unknown. An unresolved dispatch/unknown blocks Home writes installation-wide, including new sessions, other owners, mode toggles and restarts. Only the owning human's reconciliation of the specific unknown clears it; check independently and never automatically retry. Other owners see only that writes are blocked, not private receipt details. Stop task is not a substitute for Read-only.

No Home shell/config/SSH/Docker, scripts, automations, Core or Supervisor-admin operations. No generic service/JSON proxy or new Supervisor privilege. Avoid safety-critical devices. This slice is offline/source-tested only; live/mobile/restore/power-loss paths need separate authorization and validation.

`/data` survives restart/update but not uninstall. Cold App backups are sensitive and do not include the separate worker's files. Restoration does not undo device/file effects; old approvals are invalidated and uncertain effects need human reconciliation. Disable workspace/actions and stop only the specific App/worker to roll back; preserve files unless deletion is explicitly intended. No Home Assistant Core restart is needed for this App's ordinary install/configuration.
