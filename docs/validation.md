# Validation and release gates

Baseline validation date: **2026-10-03**. Version **0.2.0** adds matching pinned Pi1.0.1, protected subscription OAuth and a separately confined coding worker. It is an experimental preview, not a production recommendation or external audit. The 0.1.0 CI evidence below is baseline evidence, not proof of the new worker or a live deployment.

## Reproduce local checks

Use the exact Node LTS version in `.node-version` (**24.21.0**):

```sh
npm ci
npm --prefix hearth_pi ci
npm run check
```

The root check runs pinned formatting checks, TypeScript checking, Node test suites, production compilation, App-manifest/build-context assertions, browser syntax checks and a local secret-pattern scan. Tests use synthetic identities/credentials, an offline provider or fake HTTP. They do not connect to a real home or paid model account.

### Verified baseline

- Target Node 24.21.0 typecheck and production TypeScript build pass.
- Real version-pinned Pi Durable harness with SQLite `synchronous=FULL`, persistent catalogue and content-bound request deduplication.
- A second connection cannot open the active store; reopening hydrates committed history and ownership.
- Actual subprocess **SIGKILL** tests recover unfinished model/read tasks and preserve request identity.
- A crash after persisted dispatch intent leaves an unknown action; recovery does not resend it.
- In Ask, exact scoped HA actions are proposal-only until owner/hash/policy/expiry checks and human approval; concurrent approvals produce one attempt. The unreleased Full access source slice below adds explicit scoped automatic authorization.
- Local/Ingress authentication, forged identity rejection, browser-bound CSRF/Origin policy, HTTP body validation and authenticated SSE snapshots.
- Pinned OpenAI Responses adapter exercised through synthetic HTTP: official endpoint, authentication, streaming/error handling and `store:false` request. No live inference is claimed.
- Turn/tool/output limits and text-only untrusted-content rendering.
- Configured credential redaction before durable input/title admission, credential-bearing request-ID rejection and resolution-note redaction.
- Desktop Chrome offline smoke: session creation, message submission, displayed faux response, and hydration after page reload in a second browser profile. This does not establish mobile or Supervisor Ingress behavior.
- Production dependency audit reported zero known npm advisories at inspection time; this does not establish that dependencies have no vulnerabilities.

Test names and current counts come from the test runner, not this document. A green local run is evidence for these paths, not proof of integration with all Supervisor/Core/model versions.

## New 0.2.0 gates

Node24.21.0 clean install and local full check passed: **22 tests**, formatting, typecheck, build, package/lockfile/browser validation and public secret-pattern scan. Production dependency audit: zero known advisories. Two independent read-only reviews identified refreshed-secret HA redaction and partially failed Bash follow-up gaps; both reproduced failing regression tests, then passed after fixes. This is internal review, not an external security audit.

Synthetic tests exercise official Pi device-code OAuth through fake HTTP, protected credential storage/serialized refresh/restart/logout, owner-bound temporary login and state-required browser fallback. They never authenticate a real account. Matching Pi1.0.1 resolves a vulnerable dependency shrinkwrapped by SDK1.0.0; do not waive the production dependency audit.

Genuine Pi read/write/edit/bash are exercised through bounded authenticated IPC. Explicit Home/Code capability groups, unknown-outcome blocking and a real subprocess SIGKILL prevent both durable replay and fresh model-driven coding reissue before human input. These local tests do not establish OS isolation.

The native amd64/aarch64 **0.2.0 gates passed** for `6fbad7c`: [CI run](https://github.com/cosmyo/ha-pi-durable/actions/runs/37165250386). Both jobs ran all checks/audit plus controller and worker Docker smoke. The worker gate now uses an actual private named volume with `volume-nocopy`, verifies ownership/writability, all five zero capability sets, no-new-privs/seccomp/enforcing AppArmor/read-only rootfs/no routes, missing HA/Docker resources and genuine tools.

### Scoped live HA evidence — 2026-10-04

On an authorized Raspberry Pi5/aarch64 target, Core **2026.9.4**, Supervisor **2026.09.3**:

- Hearth **0.2.0** installed and started alongside existing services; no public ports. Controller runs as UID/GID1000 with zero effective capabilities and enforcing AppArmor.
- Real external HTTPS Ingress owner/CSRF-bound Home and Code creation returned201, protected snapshots/catalog and SSE returned200. Direct loopback with forged identity/forwarded headers returned403. Desktop auth dialog rendered. This does not establish mobile or all proxy topologies.
- Actual scoped read of virtual `sun.sun` passed and an unconfigured entity was rejected. Service actions remained disabled; no physical device was switched.
- Separate worker passed the live confinement/mount/route/credential-denial gate. Controller-to-worker genuine Pi write/edit/read/bash passed on a synthetic Python calculation. This was **operator-driven tool smoke, not LLM inference**.
- App-only restart preserved/hydrated both empty synthetic session catalogues; worker remained independent. Core API answered and Core and the other running services retained their pre-install start timestamps.
- Live validation caught Docker empty-volume copy-up resetting ownership: the new empty volume was explicitly inspected/repaired, `volume-nocopy` added, startup strengthened and named-volume CI repeated. No broad/changing ownership of existing user files, Core configuration or host permissions.

Controller source was `11e7567`; worker/installer correction `6fbad7c`. No personal credentials were copied. Human ChatGPT login and a model-driven demo remain unverified.

## Baseline container gate — not executed locally

The local Docker daemon was unavailable and was not started. The isolated gate **passed on native GitHub Actions Linux amd64 and aarch64 runners** for commit `f5a9793`: [run and job evidence](https://github.com/cosmyo/ha-pi-durable/actions/runs/37142875226). Both jobs ran the full checks, production dependency audit, and container smoke. Reproduce with:

```sh
# From repository root on a machine with Docker already authorized/running:
sh scripts/container-smoke.sh amd64
sh scripts/container-smoke.sh aarch64
```

The script builds the complete `hearth_pi/` context, uses an offline provider and a temporary synthetic `/data`, disables networking, checks private data ownership/UID drop and forged Ingress rejection, and checks restart/graceful stop. It publishes no ports, performs no registry push and makes no HA calls. Cross-architecture execution needs suitable Docker emulation or a native runner. The successful CI jobs used separate native Linux amd64/ARM64 runners. This is container smoke evidence, not a real Home Assistant installation.

Container/source inspection is not the same as an isolated Supervisor installation. Source uses a pinned official multi-platform Node image, exact dependency lockfile, a narrow root bootstrap and a privilege drop before harness/network/model work. Whether actual AppArmor, options ownership, UID/data permissions and lifecycle behave as intended must be tested in the target Supervisor environment.

## Isolated Home Assistant gate — before wider release

Follow [App installation/options](../hearth_pi/DOCS.md) only on an authorized test installation. Keep production systems and credentials out of fixtures and logs.

1. Build/install from a clean source tree on amd64 and aarch64. Verify App metadata and no unrequested mounts/ports/admin privileges.
2. With action control disabled, verify exact configured user IDs, real Ingress peer/header behavior, unauthorized users and direct-access rejection.
3. Test external HTTPS and mobile/embedded browser Origin, cookie path, CSP and SSE reconnect behavior. The exact configured origin is intentional; alternate origins are not automatically accepted.
4. Verify empty scope denies reads, configured entity scope is enforced, and broad HA token permissions do not become generic tools.
5. Test provider setup with an approved test account and known tool-capable model. Check billing and data-sharing warnings; keep tokens out of recordings.
6. Test harmless explicit light targets with approved exact policies, proposal review/rejection/expiry, one-use decisions and readable action receipts. Observe device state independently; HTTP acceptance alone is not verification.
7. Interrupt active read/model work, restart/update and confirm recovery. Interrupt action dispatch and independently reconcile unknown outcomes; do not automatically retry.
8. Exercise cold backup/restore and settings/credentials reprovisioning. Restore replaces state; old approvals are invalidated on startup. An external device does not roll back with the backup.
9. Verify graceful shutdown within the App timeout, startup data ownership and duplicate-store rejection.
10. Record tested Core/Supervisor/browser versions and architecture, plus unresolved issues. Do not imply compatibility outside that evidence.

## Explicit limitations

Not yet established: Supervisor compatibility beyond the scoped target above, real mobile iframe behavior, backup restore, live account authentication/inference, physical power loss, large-home latency/token benchmarks and external security review. SQLite FULL asks the database/filesystem to synchronize; local SIGKILL tests are not power-cut tests. Work may repeat model requests and safe reads after a crash, incurring cost. No exactly-once physical-effect guarantee, automatic write retry, voice/Assist bridge, HA configuration editing or custom/local inference endpoints. OAuth and isolated coding are now implemented, but a mock login/source test is not evidence of live subscription success or target-OS confinement.

The local secret scanner detects selected patterns and excludes deliberate synthetic fixtures. It is a preflight aid, not comprehensive secret discovery. Review the actual public diff, dependency licenses/advisories and install documentation before publishing. Publishing and production deployment require a separate decision.

## Home permissions source slice (unreleased)

Offline pinned Harness/faux-model/fake-HA tests cover Read-only/Ask defaults, exact manual approval, acknowledged Full one-shot/duplicate receipts, stale revisions, disabled/changed exact policy and no grant resurrection, owner/kind isolation, no elevation of running/legacy inputs, prompt revocation during HA validation and after dispatch, Read-only winning between intent and attempt, and installation-wide unknown barriers across conversations/owners/mode toggles/restart until specific human reconciliation. HTTP tests exercise authenticated owner-only settings, strict bounded bodies, Origin/CSRF/stale fingerprint failures, manual Read-only denial, count-only large-scope diagnostics and permission-only SSE hydration. Safe DOM tests cover disabled approval and preserved text rendering. Synthetic exact-scope tests cover10,000ID limits and twenty-item pagination past500.

Actual SIGKILL fixtures interrupt automatic execution before intent, after committed intent but before attempted POST, and during attempted POST. Unsafe tools do not replay; intent/attempt recover to unknown and block fresh autonomous reissue. Existing Code/canvas/OAuth/auth/single-writer suites remain regression gates. No real HA/provider/device operation or deployment was performed for this slice. No mobile/backup-restore/power-loss/all-HA-capability/host-admin-autonomy or external-audit claim is made.
