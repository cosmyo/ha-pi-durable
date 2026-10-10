# Isolated Pi coding workspace

Version 0.2.0 adds an **optional separate worker**, not a shell inside the HA controller. It uses the genuine pinned Pi coding-agent tool factories. Pi Durable still owns admission, conversation/task state, recovery and tool intents. Ordinary Pi session JSONL is not substituted for durable execution.

## Boundary

```text
Authenticated operator → durable Home session → scoped HA tools / Home Read-only, Ask or explicitly granted Full
                       → durable Code session → authenticated local IPC → worker
Controller → official model provider; private OAuth/API credentials stay here
Worker → its own /workspace files + temporary /tmp; no network or HA/model API
```

- Code sessions explicitly select only the coding extension. Old/Home sessions never implicitly acquire it.
- Coding is limited to **workspace owners**. By default that is the single authorized owner: with `workspace_owner_ids` empty, `workspace_enabled: true` still requires exactly one entry in `authorized_user_ids`. A household with more authorized owners names who may code in `workspace_owner_ids` (at most 5 HA user IDs, each also in `authorized_user_ids`). Only those owners can create, see, open or use Code sessions; for anyone else the server answers `403 workspace_not_allowed`, their bootstrap reports `workspaceEnabled: false` (no Code button), and the controller refuses to send a Code session of a non-owner to the worker. All workspace owners' Code sessions share **one** private workspace volume: list only people who trust each other with every file in it. This is not multi-tenant per-owner or per-session filesystem isolation. Removing an owner hides (does not delete) their Code sessions and does not erase files: review/explicitly transfer or separately replace the worker volume before granting a different owner access.
- Worker is a separate container: UID1001/GID1000, all capability sets zero, no-new-privileges, seccomp, enforcing `docker-default` AppArmor, read-only root filesystem, PID/memory/CPU limits and `--network none`.
- Only private workspace storage and the fixed IPC bridge are mounted. No controller `/data`, HA Core configuration, Docker socket, SSH material, Supervisor/HA/provider credentials or inherited network FDs.
- The shared key is **only** a worker-IPC capability, not an HA/model credential. HMAC covers direction, unique operation ID, exact arguments and expiry. The worker cannot nominate an HA owner, invoke HA/model/host APIs or turn IPC into an HTTP proxy. Treat results as untrusted text.
- `cwd` is **not** the sandbox. Pi's tools allow arbitrary paths and shell commands inside their container. Confinement is provided by the container/namespace/mount/capability policy, not command or path deny-lists.
- All four durable coding tools are `replay: unsafe`, including reads. A crashed workspace turn, uncertain transport/tool outcome or reported tool failure (including non-zero shell exit with possible partial effects) blocks further autonomous tool execution for that admitted input. A fresh explicit human input is required after inspecting/reconciling files. Retrying an unacknowledged input with its original request ID does not release the guard.

No package downloads/Internet access. Python, Node, Bash and Git are installed in the worker image; public dependencies can be baked into a reviewed image by the operator. Default Pi project resources, credentials, extensions, skills and MCP servers are not discovered/loaded.

## Operator installation

This preview requires a Docker-capable **trusted operator** on an authorized HA test host. It is not a one-click Supervisor-managed worker and does not grant Docker access to the App or model. Do not weaken host/AppArmor/SSH protections to make it start.

1. Install Hearth Pi through the App store. Set `workspace_enabled: true` with either exactly one trusted HA user ID in `authorized_user_ids`, or the trusted coding owners in `workspace_owner_ids`; start the controller to initialize its own `/workspace_link/bridge`.
2. On the authorized Docker host, obtain a clean source checkout and build the worker:

   ```sh
   docker build -f hearth_pi/Dockerfile.workspace -t hearth-pi-workspace:0.2.0 hearth_pi
   # Example slug only. Replace with your App's actual repository prefix.
   sh scripts/install-workspace.sh local_hearth_pi hearth-pi-workspace:0.2.0
   ```

3. The installer resolves only the controller's own `addon_config` mount via Docker inspection (current `app_` or legacy `addon_` container name). It initializes a new private UID1001/GID1000 `0700` workspace volume with `volume-nocopy`: Docker must not reset an empty initialized volume from the image directory. It never silently replaces an existing worker/container or recursively changes user files. An existing volume with wrong ownership needs explicit operator inspection, not automatic repair.
4. Verify Docker flags/mounts, worker startup gate, UID/capabilities/no-new-privs/seccomp/AppArmor, no routes, absence of HA/provider secrets and genuine tool execution. The worker fails closed if confinement is missing. A successful `docker run` is not verification.
5. Sign in/configure inference in the controller, create **＋ Code**, and request work on synthetic files first. No physical HA actions occur from Code mode.

## Lifecycle, rollback and backups

Controller and worker restart independently. The worker executes only newly authenticated requests; it does not restore/replay a shell queue. An interrupted durable Code turn keeps its guard until a fresh human instruction. An uncertain result is not proof that files are unchanged.

To disable, set `workspace_enabled: false` and restart only the App. Stop the specifically named `hearth-pi-workspace` container through the trusted operator. Keep `hearth-pi-workspace-files` unless you explicitly want to delete coding files. Never remove unrelated containers/volumes. The controller has no Docker lifecycle tool.

Cold App backup protects its controller database/options/OAuth credentials; it is sensitive. It does **not** back up the separate coding volume. Back up workspace files separately while idle, according to their sensitivity. Restoration cannot undo file or device effects. Database/schema upgrade and backup restoration remain separate validation gates.

## Reproducible synthetic gates

```sh
npm run check
sh scripts/workspace-smoke.sh amd64
sh scripts/workspace-smoke.sh aarch64
```

Unit tests exercise the real tools over bounded authenticated IPC, exact session scope, unknown-outcome guard and real subprocess SIGKILL recovery. The native Docker gate adds actual OS confinement and mount/route denial checks. Synthetic tests are not proof of a live subscription, production robustness, kernel exploit resistance or a formal security audit. Consult [current evidence](validation.md).
