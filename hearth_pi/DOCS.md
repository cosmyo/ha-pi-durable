# Installation and configuration (experimental 0.2.0)

Use an **authorized test Home Assistant OS installation**, an administrator account and a backup/rollback plan. Supported architectures: **amd64** and **aarch64**. This is an experimental community App, not an official HA/Pi product, a HACS package or a Devices & services integration. Container/Core installations without Supervisor cannot install it. See [validation](../docs/validation.md) for actual evidence—not a blanket compatibility claim.

## Add the repository and install

[![Add Hearth Pi's repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fcosmyo%2Fha-pi-durable)

1. Click the button, enter/select your HA instance URL and confirm **Add**. The official My Home Assistant page only opens the repository dialog; you still review and install the App yourself.
2. Alternatively, open **Settings → Apps → Install app** (App store), select **⋮ → Repositories**, add `https://github.com/cosmyo/ha-pi-durable` and select **Add**.
3. Find **Hearth Pi** in the new repository card, open it and select **Install**. The preview is built on your HA host; allow several minutes and check the App/Supervisor logs if installation fails. No manual Git, Node, SSH or Docker setup is required for Home mode.
4. Open the App's **Configuration** tab and complete the following options **before starting**. Older HA versions call Apps **Add-ons** and Install app **Add-on store**.

A developer/local build is also possible by copying the complete `hearth_pi/` directory to `/addons/hearth_pi`; it is not needed for the App-store path.

## Configure before starting

1. Enable **Advanced mode** in your HA profile if needed. Go to **Settings → People → Users**, open your trusted administrator user and copy its **ID**. This is the HA user ID, not a person entity or a token.
2. Set `public_origin` to the **exact HTTPS origin used to open HA**, e.g. `https://home.example`: no path or trailing slash. This preview requires HTTPS Ingress (such as an existing HA Cloud or HTTPS reverse-proxy URL); plain HTTP LAN access is not a supported alternative. The My Home Assistant instance URL should use this same origin.
3. Choose the provider and list the exact entities Hearth may read. Copy IDs from **Settings → Devices & services → Entities**. The example `sun.sun` is optional and only works if that entity exists on your instance. Remove it or replace it with your intended scope. Empty means deny all; there is no wildcard/domain-wide grant.

Example for subscription login; replace both placeholders:

```yaml
authorized_user_ids:
  - REPLACE_WITH_YOUR_HA_USER_ID
service_actions_enabled: false
allowed_services: []
allowed_entities:
  - sun.sun
public_origin: "https://home.example"
provider: openai-codex
model: ""
openai_api_key: ""
workspace_enabled: false
```

Select `provider: offline` instead to test startup without AI credentials; its replies are synthetic, not model inference. Do **not** create or paste an HA long-lived access token: the App gets its server-side HA API credential from Supervisor. Never put provider credentials or login redirect URLs in chat or issue reports.

4. Save, open the **Info** tab and select **Start**. Enable **Start on boot** and **Show in sidebar** if desired, then select **Open Web UI**. Refresh the HA browser if the sidebar entry has not appeared. The sidebar is admin-only; it does not replace the App's explicit user authorization.
5. For subscription mode, open **Account** from the sidebar drawer (or the ☰ menu on phones) and complete sign-in below. Create a **Home** session and ask about an entity you allowed. **Code** sessions intentionally have no HA tools. Changing App options requires restarting **only Hearth Pi**, not HA Core.

## Optional Code mode

Leave `workspace_enabled: false` for the normal App-store installation. The sidebar/App installation does **not** provision the isolated coding worker. Code mode requires the separate trusted-operator setup in the [workspace guide](../docs/workspace.md), one authorized operator and its own backups. There is no one-click Code-worker installation in this preview; do not enable it without the worker or relax its confinement.

## Troubleshooting first startup

- **Repository not visible:** refresh the App store/browser; inspect **Settings → System → Logs → Supervisor** for repository/build errors. Check your architecture and Internet access.
- **No sidebar entry:** enable **Show in sidebar** on the App's Info tab, use an administrator account and refresh HA. **Open Web UI** is the direct alternative.
- **Access denied:** check `authorized_user_ids` and the HTTPS origin; sidebar visibility alone does not authorize you. Do not disable authentication or paste tokens to bypass it.
- **No HA entities:** check `allowed_entities`, save/restart Hearth and use a **Home** session. The default is intentionally empty. Reads need no service-action permissions; keep those disabled while testing.
- **Cannot send a prompt:** check the configured provider and the session's committed model. For `local`, save an endpoint under **Local model** first. For a ChatGPT/Codex (or Anthropic) model, wait for that provider's **Subscription connected**; HA authentication and ChatGPT authentication are different.

Official HA references: [adding a third-party App repository](https://www.home-assistant.io/common-tasks/os/#installing-a-third-party-app-repository), [App publishing and local builds](https://developers.home-assistant.io/docs/apps/publishing/).

## Required options and trust

- `authorized_user_ids`: explicit trusted HA operator IDs. `[]` denies everyone. Server identity requires the documented Ingress socket peer and one `X-Remote-User-Id`; sidebar admin visibility is not authentication or proof of current role. Authorized operators may use/setup/remove the installation's shared provider credential. Do not add untrusted/guest users.
- `public_origin`: exact external HTTPS origin, no path/trailing slash, e.g. `https://home.example`. Needed for Origin/CSRF and iframe policy. Alternative origins are not implicitly accepted.
- `allowed_entities`: up to 10,000 exact entity IDs for Home reads and optional supported actions; no wildcards/all-future scope. Search pages contain twenty items. Empty denies all. Scope filters output, not the broad underlying HA token or states response processed in memory.
- `anthropic_auth_enabled`: **false by default**. Typed HA option fallback for the `HEARTH_ANTHROPIC_AUTH_ENABLED` environment flag; an explicitly set env value takes precedence and only exact `true` enables it. This gates Anthropic login/inference/compatibility only, not ChatGPT. Enabling it does not change provider/model, scope, Home permissions or the Code worker.
- `provider`: `offline`, `openai`, `openai-codex`, flagged `anthropic` or `local`. Offline is a faux response, not local inference. `local` uses an OpenAI-compatible server on your network that you connect from the UI; see [Local model endpoint](#local-model-endpoint-unreleased-source-slice). Online conversations and selected HA/coding output go to the provider.
- **Updated requested default:** `openai-codex` new sessions use `gpt-6.1-sol` with **medium thinking** when `model` is empty. An explicit `model` option remains the operator's model default (the operator must set it to `gpt-6.1-sol` if already configured differently); Codex new-session thinking defaults to medium. API-key mode defaults to `gpt-4.1-mini` / off and offline to faux / off. The selected model must be in the pinned provider catalog; provider account limits apply. This changes no existing session's explicitly committed model/thinking choice and never rewrites admitted work.
- `openai_api_key`: used only for `openai` API-key mode. Server-side secret; options/backups are sensitive. ChatGPT subscription access does not make this API billing free.
- `service_actions_enabled`: false by default. Optional `allowed_services` contains only `light.turn_on`, `light.turn_off`, `switch.turn_on`, `switch.turn_off`, with exact allowed entities. **Home permissions** defaults to Read-only with writes disabled, otherwise Ask: the model proposes and the human approves the immutable entity/data/hash once. The authenticated owner may explicitly acknowledge Full access / auto-approve for only these configured exact actions (optional brightness 0-255 for light.turn_on). This is not all HA services or host/admin access; Code is unchanged and separately confined. No indirect area/device/group selectors. An HTTP receipt is not device verification.
- `workspace_enabled`: false by default. True requires exactly one trusted operator and a **separate confined worker** installed by the trusted host operator; it does not create a container or expose Docker. [Workspace guide](../docs/workspace.md).

## Session model and thinking

The authenticated session picker (opened from the composer's model chip) lists chat models from the already configured provider's local in-process Pi Models registry plus those of every available subscription provider (ChatGPT/Codex; Anthropic only when its flag is on) that is currently **signed in**, grouped by provider when more than one is available. Each choice is a provider/model pair; choosing a model of a provider that is not signed in is refused until you sign in. A session committed to a subscription provider that is later signed out keeps its committed choice but cannot send until you sign in again or switch it. The `offline` demonstration keeps its faux-only choice. It performs no network catalog refresh and does not prove account entitlement. Choose model and thinking, then press **Apply model and thinking**; merely opening a session, selecting a choice, restarting or deploying never applies a draft. Actual committed session model and thinking are shown beside the picker and hydrated from snapshots/SSE. Applying persists both in the conversation's durable `pi.agent` document; the next human input uses them without an App restart. Running/admitted inputs, unresolved actions, and interrupted Code continuations cannot be switched; stale revisions fail and must be reviewed anew. Transcripts, usage, Home permission grants/policy and canvas are unchanged. New sessions receive the operator's configured model (Codex default `gpt-6.1-sol`) and medium thinking; old sessions retain their committed choice until explicitly applied. Switching does not change provider login or grant additional permissions.

## ChatGPT subscription login

1. Select `provider: openai-codex`; leave `model` empty or choose an appropriate catalog model. Restart **only this App** after option changes.
2. Open **Account** from the sidebar drawer. ChatGPT/Codex is always listed there (independently of the configured inference provider); select **Sign in with ChatGPT**. Like Pi's interactive `/login`, the sheet shows whichever step Pi's own login flow is waiting on: first Pi's method choice, with **Device code login (headless)** listed first and marked **Recommended for Home Assistant and phones** (no pasting needed — just a code to enter at OpenAI) and **Browser login** listed second with a note that it needs pasting a redirect URL. Pi's own option ids/labels are unchanged; only the order and the annotation are added. Choosing device code shows a large code with a **Copy code** button (falls back to selecting the text if the Clipboard API is unavailable), a prominent **Continue at OpenAI** link/button and three steps (copy the code, open OpenAI, approve). While Pi polls, the dialog shows **Waiting for approval at OpenAI… this window updates automatically**; it updates to **Subscription connected** once Pi confirms. If device code login fails, the hint suggests enabling it in your OpenAI account security settings or switching to Browser login. Complete the login/consent in your own OpenAI browser session; account eligibility and provider limits apply.
3. Browser login uses the official Pi PKCE flow. If localhost:1455 cannot reach HA, paste the **complete final redirect URL with code and state** into the protected password field, not chat. The official flow verifies state. No callback port is publicly exposed.
4. Wait for **Subscription connected**. The dialog shows the access token's expiry time, never the token. Pi refreshes it automatically before model requests; **Check connection** asks Pi to resolve auth the same way (refreshing only if it is close to expiry) and records OK/failed. If a check fails, choose **Sign in again**. Access/refresh tokens stay in private controller `/data`, never in browser responses, model context or coding storage. Login state is owner-bound, temporary and cancellable. No personal Pi credentials/resources are automatically imported.
5. Local sign-out removes this App's credential; it does not revoke the OpenAI account or retroactively undo requests already sent. Backups containing credentials must be protected.

## Anthropic login feature flag (unreleased)

Anthropic OAuth compatibility is experimental and disabled by default. Provider terms, account eligibility and extra-usage billing may apply; logging in does not guarantee included Claude-plan usage.

1. For a local developer run, set `HEARTH_ANTHROPIC_AUTH_ENABLED=true`. In Home Assistant, set the typed App option `anthropic_auth_enabled: true`; this is the fallback when the env variable is absent. Only exact env `true` enables the flag; an explicit `false` overrides the option.
2. Optionally select `provider: anthropic` to make Claude the default for new sessions. Without it, both logins are offered side by side and signed-in Claude models appear in the session model picker of any non-offline provider. With `provider: anthropic`, set `model: ""` for `claude-sonnet-5` / thinking off, or select a pinned catalog model. Restart **only Hearth Pi** after changing options. Enabling the flag alone leaves your existing provider/model unchanged. Create a new session for Claude; existing sessions retain their committed model/provider.
3. Open **Account** from the sidebar drawer, where Anthropic/Claude (experimental) is listed alongside ChatGPT/Codex, and select **Sign in with Anthropic**, or enter `/login anthropic` in the composer. Plain `/login` uses the configured provider when it is a subscription provider, otherwise ChatGPT/Codex; `/login openai-codex` and `/login anthropic` choose explicitly. Signing in never switches an existing session's model; use the session model picker. Commands open human auth and are not saved as conversation input or sent to the model.
4. Pi's native method selector offers **Browser login** and **Copy code login (headless)**. Use Copy code for remote HA: complete consent at `claude.ai`, then paste the complete **code#state** into the protected password field. A complete `https://platform.claude.com/oauth/code/callback` URL containing code and state is also accepted. Bare codes, mismatched state, foreign callback origins and stale/other-owner transactions are refused. Browser fallback requires the complete `http://localhost:53692/callback` URL with code and state. No callback port is published.
5. Wait for **Subscription connected**. Expiry, **Check connection**, cancellation and local sign-out use the same protected Pi flow as ChatGPT. Check connection resolves/refreshes auth, **not a live inference or billing test**. The separate controller file `/data/anthropic-oauth.json` is `0600`; ChatGPT's existing credential is preserved. Both providers' files are served through one Pi model runtime that delegates each provider to its own file and refresh lock, so both can be signed in at once. No Mac credentials are imported.

Hearth reuses the actual pinned compatibility package as a dependency; it does not copy its transport implementation into the application. It loads only the package's OAuth transport helper through a local, non-discovering TypeScript loader. No extension factory, personal/project configuration, account diagnostics or debug payload logging is loaded. Pi owns login, refresh, model catalog and transport; API-key/non-OAuth requests pass through unchanged. The package may retry a model request once after an explicit version-floor rejection, but never dispatches a tool or retries a Home/Code effect. Package version changes require retesting.

To disable, switch away from `provider: anthropic` and turn the flag off, then restart only Hearth. With the flag off nothing Anthropic is offered or read: no login, provider status, models or stored-token use. With Anthropic selected and the flag off, startup fails closed; it never silently changes providers. Disabling does not revoke or erase stored tokens; sign out locally first if removal is wanted. This slice has synthetic tests only, no real Anthropic login, included-usage/billing proof or live Claude inference.

OAuth is an account authorization step performed by the human, not a model tool. Never share codes, redirect URLs, tokens, options or SQLite in issues/videos. A synthetic test is not a successful live login.

## Local model endpoint (unreleased source slice)

Use an OpenAI-compatible server on your own network, such as Ollama, LM Studio, llama.cpp (`llama-server`), vLLM or a compatible proxy. This follows the shape of Pi's own `/login llama.cpp` (enter a server, validate it by listing models) and of community Pi extensions such as Crossbar and pi-lm-providers (fingerprint the server, then pick a model). No code from those extensions is included.

1. Select `provider: local`, leave `model` empty and restart **only this App** once.
2. Open **Local model**. Enter the server URL, for example `http://192.168.1.50:11434` (usual ports: Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000). Add an API key only if the server requires one.
3. **Test connection** calls `GET /v1/models` and a few public metadata endpoints to identify the server, read context windows and hide embedding models. With Ollama, it also hides models that don't report tool calling, which Home mode requires.
4. Choose the default model and select **Use this endpoint**. Its models appear in the session model picker immediately, with no restart. **Refresh models** re-lists the saved server; **Remove endpoint** deletes it and its key.

Boundaries:

- There is no network scanning. Hearth contacts only the URL an authorized owner types.
- Only private addresses are accepted: loopback, 10/8, 172.16/12, 192.168/16 and IPv6 unique-local. Host names must resolve only to such addresses. Link-local/cloud-metadata ranges, the `supervisor` host and 172.30.32.2 are refused. Redirects are not followed. DNS can change after the check; this guards against mistakes, not a hostile DNS server.
- Everything you discuss, including selected Home data and tool results, is sent to that server. Trust it as you would a cloud provider.
- The endpoint, model list and optional key are stored in private controller `/data` (`0600`), never in browser responses or model context. Keys are limited to plain token characters, because Pi treats keys starting with `!` or `$` as commands or environment references.
- Startup reloads the saved endpoint without contacting it. If its host name can't be resolved to a private address at boot (for example, a server App that starts later), Hearth still starts and asks you to **Refresh models**. Sessions can't be created and inputs are refused until an endpoint is saved.
- Model quality and tool calling depend on the local model; small models may call tools poorly. Only `thinking: off` is offered for local models.

This is source-tested with fake servers and a real local HTTP server, not against a real Ollama/LM Studio/vLLM installation or on Home Assistant OS.

## Deleting a session

In the sidebar drawer, open a session row's **\u22ef** menu (`aria-label="More for <title>"`) and choose **Delete**. The confirmation names the session and states this cannot be undone through the App. Deleting removes it from your list, from the owner-scoped session count used for the 30-per-owner / 100-total limits, and from every session-scoped API route, which then answers `404` as if it never existed; an already-deleted or already-gone id also answers `404`. **The committed transcript is not securely erased**: Pi Durable 1.0.1 has no API to erase a conversation or its entries, so the data remains in the private App store (`/data`) until the whole store is removed, per "Privileges, state and rollback" below.

Deletion is refused (`409`, a distinct error per reason) while the session still has an open safety concern, so a removal can never quietly drop one:

- an action proposal awaiting approval, dispatching, or with an unknown outcome — reject or resolve it first;
- a durable task still running for that conversation;
- an admitted input that has not yet been answered or placed;
- for a coding workspace session, a `WorkspaceGuard` still paused after an uncertain operation.

These checks, and the removal itself, run serialized with session creation/submission and are re-read inside the same commit that removes the session, so the installation-wide unknown-outcome write barrier can never be silently lifted by deleting the conversation that holds it.

## Privileges, state and rollback

Ingress only, no host ports, HA Core configuration mounts or Supervisor/admin/auth/Docker API. `/workspace_link` is this App's own `addon_config` mapping, only for worker IPC—not HA Core `/config`. HA's token is broad; the App's fixed tools enforce narrower policy. Code mode has no HA tools; its worker has no HA/model network or credentials.

## Home permissions (unreleased source slice)

Open **Home permissions** from the drawer row or the mode badge next to the conversation title to use the selector and choose Read-only, Ask or Full access. Full acknowledgement binds to the displayed exact policy fingerprint, revision, schema and owner; settings persist in the existing durable store, not browser storage. New Full inputs may execute supported requests without per-action prompts. Running/legacy inputs cannot acquire Full, and choosing Full never executes old Ask proposals. Exact scope/service or schema changes invalidate Full; changing the policy back does not restore the grant.

Emergency Read-only stays available during work. It invalidates pending actions and promptly prevents/cancels dispatch; it cannot undo an already attempted effect. Receipts show human/automatic authorization, revision and accepted versus unknown. An unresolved dispatch/unknown blocks Home writes installation-wide, including new sessions, other owners, mode toggles and restarts. Only the owning human's reconciliation of the specific unknown clears it; check independently and never automatically retry. Other owners see only that writes are blocked, not private receipt details. Stop task is not a substitute for Read-only.

No Home shell/config/SSH/Docker, scripts, automations, Core or Supervisor-admin operations. No generic service/JSON proxy or new Supervisor privilege. Avoid safety-critical devices. This slice is offline/source-tested only; live/mobile/restore/power-loss paths need separate authorization and validation.

## Apps (unreleased source slice)

Ask Hearth in a Home chat for a small household app — “Make me a laundry app”, “a bedtime lock-up check”, “a 3D print monitor”, “a maintenance checklist”. The model writes a declarative **HAS/1** spec (`specVersion: "has/1"`): a flat element map from a fixed catalog (Stack, Grid with 1–3 columns, Tabs, Card, Section, Text, EntityValue, EntityTile, StatusPill, HistoryChart, Checklist, Counter, Note, AskButton, ToggleAction). It chooses structure and exact entity bindings only; it cannot write values, HTML, links, scripts or styles, and it has no tool to press buttons, tick checklists or run anything.

- **Validation.** Hearth rejects unknown components/props, cycles, shared children, orphans, missing roots, nesting deeper than 6, more than 80 elements or 8 tabs, oversized text, markup/script-like text, literal values in entity-bound props, entities outside the app's `scope.entities` or outside `allowed_entities`, and ToggleActions whose `<domain>.turn_on` and `<domain>.turn_off` are not both in `allowed_services`. Errors name the exact JSON path so the model can repair the spec in one turn. `catalog_describe` is generated from the same schema and includes four starting templates.
- **Values.** Opening an app makes fresh controller reads of its bound entities through the existing scoped reads; each value shows an “as of” time. Unavailable entities, failed reads and entities later removed from `allowed_entities` show **Unavailable** (and the app is flagged “needs repair”) instead of a guess. HistoryChart reads at most 3 entities over at most 48 hours from the recorder, without attributes, and Hearth downsamples it to 48 points (text states show their last 12 changes). Values are not live telemetry; use ↻ to read again (rate-limited).
- **Household data.** Checklist ticks, counters and notes are app-local, stored separately from the spec, so model updates and reverts keep them. Note text and checklist items are untrusted when shown back to a model.
- **Controls.** AskButton only drafts an editable message into the current chat (or a new chat named after the app); you press Send. ToggleAction goes through **Home permissions**: Read-only shows it disabled with an explanation; Ask files the exact action (domain, service, entity, data) for approval in the current chat and shows the same approval card; Full access dispatches once within the configured light/switch scope and reads the state back. An unknown outcome is never retried and pauses Home writes until you reconcile it in that chat's action card.
- **Storage.** Apps are household objects for the signed-in owner, not tied to one conversation. Each version is an immutable Pi Durable document; `app_update` applies a JSON Patch (add/remove/replace) with optimistic concurrency, and a stale base version is refused with the current version. **Restore** under _Versions and options_ appends a new version copied from an older one. Limits: 30 apps per owner, 50 versions per app, 32 KB per spec. Delete removes the app from your list and retires its documents; like session delete, committed history stays in the private store and is not securely erased.
- **Using it.** Open **Apps** in the drawer. Tap an app to open it full screen (‹ Apps returns). Pin apps to show them at the top of an empty chat. When Hearth creates or updates an app in a chat, a compact card shows Open / Pin and, for updates, a diff summary (+/− elements, entities added).

Deferred from the iteration plan: watchers, reminders/timers, conditional visibility, SceneButton, Gauge/StatisticsChart/Logbook/Agenda, export/import, per-user visibility, live mini-status on app cards and a “try it” preview. Apps were tested with an offline model and Home Assistant fakes only; mainstream-model generation quality and the HA companion app were not verified.

`/data` survives restart/update but not uninstall. Cold App backups are sensitive and do not include the separate worker's files. Restoration does not undo device/file effects; old approvals are invalidated and uncertain effects need human reconciliation. Disable workspace/actions and stop only the specific App/worker to roll back; preserve files unless deletion is explicitly intended. No Home Assistant Core restart is needed for this App's ordinary install/configuration.
