# Installation and configuration (experimental 0.2.0)

Use an **authorized test Home Assistant installation**, with a backup/rollback plan. Public App repository: `https://github.com/cosmyo/ha-pi-durable`. Add it under **Settings → Apps → App store → Repositories**, then install **Hearth Pi**, configure before starting, and open its Web UI. Older HA versions call Apps Add-ons. A local build is also possible by copying the complete `hearth_pi/` directory to `/addons/hearth_pi`. See [validation](../docs/validation.md) for actual evidence—not a blanket deployment/compatibility claim.

## Required options and trust

- `authorized_user_ids`: explicit trusted HA operator IDs. `[]` denies everyone. Server identity requires the documented Ingress socket peer and one `X-Remote-User-Id`; sidebar admin visibility is not authentication or proof of current role. Authorized operators may use/setup/remove the installation's shared provider credential. Do not add untrusted/guest users.
- `public_origin`: exact external HTTPS origin, no path/trailing slash, e.g. `https://home.example`. Needed for Origin/CSRF and iframe policy. Alternative origins are not implicitly accepted.
- `allowed_entities`: exact entity IDs for Home-mode reads and optional reviewed actions. Empty denies all. Scope filters output, not the broad underlying HA token or states response processed in memory.
- `provider`: `offline`, `openai`, or `openai-codex`. Offline is a faux response, not local inference. Online conversations and selected HA/coding output go to the provider.
- `model`: empty selects the provider default: `gpt-4.1-mini` for API-key mode, `gpt-5.5` for Codex, faux for offline. An explicit value must be in the pinned provider catalog and available to your account.
- `openai_api_key`: used only for `openai` API-key mode. Server-side secret; options/backups are sensitive. ChatGPT subscription access does not make this API billing free.
- `service_actions_enabled`: false by default. Optional `allowed_services` contains only `light.turn_on`, `light.turn_off`, `switch.turn_on`, `switch.turn_off`, with exact allowed entities. The model proposes; the human approves the immutable entity/data/hash once. No indirect area/device/group selectors. An HTTP receipt is not device verification.
- `workspace_enabled`: false by default. True requires exactly one trusted operator and a **separate confined worker** installed by the trusted host operator; it does not create a container or expose Docker. [Workspace guide](../docs/workspace.md).

## ChatGPT subscription login

1. Select `provider: openai-codex`; leave `model` empty or choose an appropriate catalog model. Restart **only this App** after option changes.
2. Open **ChatGPT login → Sign in with ChatGPT**. Device-code mode is recommended for remote HA. Complete the login/consent in your own OpenAI browser session; account eligibility and provider limits apply. Device-code login may need enabling in OpenAI's account security settings.
3. Browser fallback uses the official Pi PKCE flow. If localhost:1455 cannot reach HA, paste the **complete final redirect URL with code and state** into the protected password field, not chat. The official flow verifies state. No callback port is publicly exposed.
4. Wait for **Subscription connected**. Access/refresh tokens stay in private controller `/data`, never in browser responses, model context or coding storage. Login state is owner-bound, temporary and cancellable. No personal Pi credentials/resources are automatically imported.
5. Local sign-out removes this App's credential; it does not revoke the OpenAI account or retroactively undo requests already sent. Backups containing credentials must be protected.

OAuth is an account authorization step performed by the human, not a model tool. Never share codes, redirect URLs, tokens, options or SQLite in issues/videos. A synthetic test is not a successful live login.

## Privileges, state and rollback

Ingress only, no host ports, HA Core configuration mounts or Supervisor/admin/auth/Docker API. `/workspace_link` is this App's own `addon_config` mapping, only for worker IPC—not HA Core `/config`. HA's token is broad; the App's fixed tools enforce narrower policy. Code mode has no HA tools; its worker has no HA/model network or credentials.

`/data` survives restart/update but not uninstall. Cold App backups are sensitive and do not include the separate worker's files. Restoration does not undo device/file effects; old approvals are invalidated and uncertain effects need human reconciliation. Disable workspace/actions and stop only the specific App/worker to roll back; preserve files unless deletion is explicitly intended. No Home Assistant Core restart is needed for this App's ordinary install/configuration.
