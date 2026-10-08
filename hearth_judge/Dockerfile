# Official llama.cpp server image (OCI index: amd64 + arm64 + s390x), build
# b11459, resolved 2026-10-08 by digest from
# https://github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp. Pinned by
# digest, not the floating ":server" tag, so a rebuild never silently changes
# the inference binary. Entrypoint is upstream's /app/llama-server; our image
# only adds jq (options.json parsing), gosu (drop to the existing non-root
# "ubuntu" user before running llama-server) and our run.sh.
FROM ghcr.io/ggml-org/llama.cpp:server@sha256:33868c035b21dc63f7c60b7438774283fd99215bc319114eb03de5df4ce7cd6b
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH
LABEL io.hass.name="Hearth Judge" \
      io.hass.description="Experimental local risk-judge server for Hearth Pi (llama.cpp, CPU-only)" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/cosmyo/ha-pi-durable"

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

COPY models.json /opt/hearth_judge/models.json
COPY run.sh /run.sh
RUN chmod 0644 /opt/hearth_judge/models.json && chmod 0755 /run.sh

# Drop the upstream root entrypoint. run.sh starts as root only to create and
# chown /data/models and /data/slots (Supervisor creates /data root-owned),
# verify/download the pinned model, then uses gosu to exec llama-server as
# the base Ubuntu 24.04 image's existing non-root "ubuntu" user (uid/gid
# 1000): the network-facing inference process never runs as root.
ENTRYPOINT []
CMD ["/run.sh"]
