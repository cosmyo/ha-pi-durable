# Add-on changelog

## 0.1.2 — answer without thinking

- Fix: Qwen3-class models spent the judge's small output budget on hidden reasoning and returned empty content. llama-server now runs with `--reasoning-budget 0` and `enable_thinking: false`.

## 0.1.1 — read options as root

- Fix: Supervisor writes `/data/options.json` readable by root only, so 0.1.0 exited at start. Options are now read before dropping privileges; the optional API key is passed to llama-server through a 0600 file (`--api-key-file`) instead of the command line.

## 0.1.0 — experimental initial implementation

Initial Hearth Judge add-on: official `ghcr.io/ggml-org/llama.cpp` server image pinned by digest, wrapped by a `run.sh` that downloads and sha256-verifies one of a short vetted model list (`qwen3-1.7b-q4_0` default, `qwen3.5-2b-q4_0` A/B candidate) into persistent `/data` and then execs `llama-server` with a single slot, a cached prompt prefix and no Web UI. No `ports:`, `homeassistant_api` or `hassio_api`; reachable only on the internal `hassio` network. Starts as root only to `chown` its two `/data` subdirectories, then runs as the base image's existing non-root `ubuntu` user. See [DOCS.md](DOCS.md) for options, networking and expected resource use/latency.
