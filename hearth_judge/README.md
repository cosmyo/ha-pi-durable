# Hearth Judge

Independent, experimental local risk-judge server for Hearth Pi, for aarch64 and amd64. It runs a small open-weight model behind the official `ghcr.io/ggml-org/llama.cpp` server image and exposes an OpenAI-compatible `/v1/chat/completions` endpoint on the internal `hassio` network only — no `ports:`, no ingress, no Home Assistant or Supervisor API access. It is a generic OpenAI-compatible endpoint judge target, not specific to any one home; it never reads HA state itself.

See [installation/options](DOCS.md), [Hearth Pi's security notes](../docs/security.md#local-risk-judge) and the [project overview](../README.md). `hearth_judge/` is the self-contained Docker build context; its only persistent data is the downloaded, sha256-verified model file and optional saved KV-cache slots under `/data`.
