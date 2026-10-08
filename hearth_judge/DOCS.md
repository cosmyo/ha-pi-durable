# Hearth Judge: installation and configuration (experimental 0.1.1)

Hearth Judge runs a small open-weight language model on your Home Assistant host itself, behind the official `ghcr.io/ggml-org/llama.cpp` server, and serves it as a generic OpenAI-compatible `/v1/chat/completions` endpoint. It exists so [Hearth Pi's optional risk judge](../hearth_pi/DOCS.md#run-the-risk-judge-on-your-home-assistant-host) can run entirely on-host instead of calling a cloud model — your owner request and the exact proposed action never leave the Home Assistant host. It is **not** a chat assistant, has no Home Assistant or Supervisor API access, and is reachable only from other add-ons on the internal `hassio` network, never from the LAN, the Internet or the HA UI.

This is an experimental community App/add-on, not an official Home Assistant or Pi product, and not a general-purpose inference server: it is tuned for one job (a tiny, strict-JSON intent-alignment check) and should not be pointed at by anything that needs a capable general assistant.

## Install

Use the same repository as Hearth Pi.

[![Add Hearth Pi's repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fcosmyo%2Fha-pi-durable)

1. Add the repository (button above, or **Settings → Apps → Install app → ⋮ → Repositories**, add `https://github.com/cosmyo/ha-pi-durable`).
2. Find **Hearth Judge** in the repository card (separate from **Hearth Pi**) and select **Install**. The first build compiles no application code — it just lays the official llama.cpp server image with a thin wrapper script on top — but still takes a few minutes on a Raspberry Pi 5.
3. Open the **Configuration** tab, choose a `model` and (optionally) an `api_key`, then **Save** and **Start**. On first start the add-on downloads the configured model into its persistent `/data` (a few hundred MB to ~1.2 GB depending on model, one time only) and verifies it against a pinned sha256 before use; watch the add-on log. It refuses to start if that verification fails or if a model's pin is missing.
4. There is no sidebar entry, ingress panel or Web UI (`--no-webui`) to open: this add-on is a backend service for other add-ons only. Confirm it is listening by checking the log for `starting llama-server`.

A developer/local build is also possible by copying the complete `hearth_judge/` directory to `/addons/hearth_judge`; its internal hostname is then always `http://local-hearth-judge:8080` (see below).

## Options

| Option     | Default           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`    | `qwen3-1.7b-q4_0` | One of a short, vetted list of GGUF models (see [models.json](models.json) for the exact Hugging Face repository, revision commit, file name and pinned sha256 of each). Changing this re-downloads and re-verifies a new file into `/data`; the old file is left in place (remove it yourself under **Settings → System → Storage** or via the add-on's **Terminal/File editor** app if you want the space back). |
| `threads`  | `3`               | CPU threads for both generation and prompt/batch processing (`-t`/`-tb`). Default leaves one core free on a 4-core Raspberry Pi 5 for Home Assistant Core itself.                                                                                                                                                                                                                                                  |
| `ctx_size` | `2048`            | Context window in tokens (`-c`). The judge's static policy prefix plus one request plus a short reply comfortably fits; raise only if you extend the judge prompt.                                                                                                                                                                                                                                                 |
| `api_key`  | empty             | Optional bearer key (`--api-key`) other add-ons must send as `Authorization: Bearer <key>`. Empty means no key is required — acceptable because this add-on is unreachable outside the internal `hassio` network, but set one if you want defence in depth. Set the matching value as Hearth Pi's `risk_judge_api_key`.                                                                                            |

Not configurable, by design: the server always runs with exactly one parallel slot (`-np 1`, hardcoded in `run.sh`), so its single KV cache keeps the static policy prefix resident and `--cache-reuse` stays effective. Sending it concurrent traffic from more than one caller defeats this; use it only as Hearth Pi's judge endpoint.

## Networking

This add-on declares no `ports:`, so it is **not** published on the host, the LAN or through ingress — only other add-ons on the internal `hassio` Docker network can reach it, by hostname. For an add-on installed from this GitHub repository, the Home Assistant documented hostname format is `{REPO}_{SLUG}` with every `_` replaced by `-`; `{REPO}` is a hash of the repository URL that you can read from `GET /addons` on the Supervisor API (see **Settings → System → Logs → Supervisor**, or the local-copy shortcut above, which is always `local-hearth-judge`). Point Hearth Pi's `risk_judge_url` at `http://<that-hostname>:8080`.

## Resource use and expected latency

- **Memory:** budget **~1.5–2.5 GB RSS** for the container (model weights ~1.0–1.2 GB at `Q4_0`, plus KV cache at `ctx_size: 2048`, plus llama.cpp runtime overhead). Home Assistant add-ons have no built-in per-add-on memory limit (open upstream feature request); this is model-size/`ctx_size`/`-np 1` based, not cgroup-enforced. Watch your Pi's free memory, especially alongside other add-ons.
- **CPU:** a Raspberry Pi 5 (CPU-only) is the target hardware. Expect roughly **2.5–5 s per judge call** at the default `qwen3-1.7b-q4_0` (prompt-processing-bound, not generation-bound, because the reply is a short strict-JSON object) — this is an estimate from comparable hardware, not a benchmark run on real Pi 5 hardware in this repository; see [the eval harness](../hearth_pi/eval/) to measure your own p50/p95 before relying on it, and `docs/research.md` for the sourcing. A desktop/server host with more CPU cores (or a GPU-accelerated llama.cpp image you build separately) will be faster.
- **Startup:** the one-time model download (step 3 above) depends on your Internet connection, not on this add-on's own CPU; after that, startup is seconds and uses no network at all. If a previously downloaded model file fails its sha256 check (corruption, interrupted download, local tampering), the add-on deletes it and re-downloads once, or refuses to start if that also fails.

## Security notes

- Read-only intent: this add-on never reads or writes anything about your home. It only ever sees whatever Hearth Pi sends it in a judge call — the owner's latest message and one proposed action's exact JSON — not entity attributes, tool output, logs, or any other HA data.
- The container's writable surface is limited to `/data` (the model file and optional saved KV-cache slots); there is no other persistent state. The upstream llama.cpp server image does not provide a declarative read-only-rootfs add-on option here — if you want an enforced read-only root filesystem, run the built image yourself with `docker run --read-only --tmpfs /tmp ...` outside Supervisor; this is a documented limitation, not implemented by this add-on's `config.yaml`.
- `run.sh` starts as root only long enough to `chown` its two `/data` subdirectories (Supervisor creates `/data` root-owned); it then drops to the image's existing non-root `ubuntu` user (uid/gid 1000) via `gosu` before downloading the model, verifying its hash, or starting `llama-server`. The network-facing inference process never runs as root.
- No Supervisor token, Home Assistant token, or Hearth Pi provider credential is ever available to this add-on (`homeassistant_api` and `hassio_api` are both omitted from its manifest). Only the optional `api_key` option is a secret here, and it protects nothing more sensitive than this endpoint itself.

See also: [Hearth Pi's security and threat model](../docs/security.md#local-risk-judge), [the evaluation harness](../hearth_pi/eval/) and the [research brief](../docs/research.md) this add-on is based on.
