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
- Exact scoped HA actions are proposal-only until owner/hash/policy/expiry checks and human approval; concurrent approvals produce one attempt.
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

The separate `scripts/workspace-smoke.sh` gate builds the worker on native Linux, checks zero capabilities/no-new-privs/seccomp/enforcing AppArmor/read-only rootfs/no routes, missing HA/Docker resources and real tools. See the CI run for the tested commit before claiming a pass. Real Supervisor installation and a human subscription login remain distinct gates.

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

Not yet established: Supervisor installation/Ingress/AppArmor, real mobile iframe behavior, backup restore, paid inference, physical power loss, large-home latency/token benchmarks and external security review. SQLite FULL asks the database/filesystem to synchronize; local SIGKILL tests are not power-cut tests. Work may repeat model requests and safe reads after a crash, incurring cost. No exactly-once physical-effect guarantee, automatic write retry, voice/Assist bridge, HA configuration editing or custom/local inference endpoints. OAuth and isolated coding are now implemented, but a mock login/source test is not evidence of live subscription success or target-OS confinement.

The local secret scanner detects selected patterns and excludes deliberate synthetic fixtures. It is a preflight aid, not comprehensive secret discovery. Review the actual public diff, dependency licenses/advisories and install documentation before publishing. Publishing and production deployment require a separate decision.
