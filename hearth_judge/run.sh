#!/usr/bin/env bash
# Hearth Judge entrypoint: downloads and sha256-verifies the configured GGUF
# model into persistent /data (once), then execs llama-server with a single
# slot and a cached static policy prefix. No other network use at runtime.
#
# This script starts as root only because Supervisor creates /data root-owned;
# it chowns the two subdirectories it needs, then drops to the image's
# existing non-root "ubuntu" user (uid/gid 1000) via gosu before downloading
# or running anything that reads model bytes or opens a network port.
set -euo pipefail

OPTIONS_FILE=/data/options.json
MANIFEST=/opt/hearth_judge/models.json
MODEL_DIR=/data/models
SLOT_DIR=/data/slots
RUN_USER=ubuntu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$MODEL_DIR" "$SLOT_DIR"
  chown -R "$RUN_USER:$RUN_USER" "$MODEL_DIR" "$SLOT_DIR"
  exec gosu "$RUN_USER" "$0" "$@"
fi

if [ ! -f "$OPTIONS_FILE" ]; then
  echo "hearth_judge: $OPTIONS_FILE is missing; refusing to start." >&2
  exit 1
fi

MODEL_KEY=$(jq -r '.model // empty' "$OPTIONS_FILE")
THREADS=$(jq -r '.threads // 3' "$OPTIONS_FILE")
CTX_SIZE=$(jq -r '.ctx_size // 2048' "$OPTIONS_FILE")
API_KEY=$(jq -r '.api_key // ""' "$OPTIONS_FILE")

if [ -z "$MODEL_KEY" ]; then
  echo "hearth_judge: no 'model' option set; refusing to start." >&2
  exit 1
fi

REPO=$(jq -r --arg k "$MODEL_KEY" '.[$k].repo // empty' "$MANIFEST")
REVISION=$(jq -r --arg k "$MODEL_KEY" '.[$k].revision // empty' "$MANIFEST")
FILE=$(jq -r --arg k "$MODEL_KEY" '.[$k].file // empty' "$MANIFEST")
SHA256=$(jq -r --arg k "$MODEL_KEY" '.[$k].sha256 // empty' "$MANIFEST")

if [ -z "$REPO" ] || [ -z "$REVISION" ] || [ -z "$FILE" ]; then
  echo "hearth_judge: '$MODEL_KEY' is not a known model in $MANIFEST; refusing to start." >&2
  exit 1
fi

# Defense in depth: never download a model this add-on cannot verify. A pin
# left as "TODO" in models.json (unverified sha256) must never reach here.
case "$SHA256" in
  "" | TODO | *TODO*)
    echo "hearth_judge: '$MODEL_KEY' has no pinned, verified sha256 in $MANIFEST; refusing to start." >&2
    exit 1
    ;;
esac
if ! printf '%s' "$SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "hearth_judge: '$MODEL_KEY' sha256 in $MANIFEST is not a 64-character hex digest; refusing to start." >&2
  exit 1
fi

MODEL_PATH="$MODEL_DIR/$FILE"

verify_model() {
  printf '%s  %s\n' "$SHA256" "$MODEL_PATH" | sha256sum -c - >/dev/null 2>&1
}

if [ -f "$MODEL_PATH" ] && ! verify_model; then
  echo "hearth_judge: $MODEL_PATH exists but failed sha256 verification; removing it." >&2
  rm -f "$MODEL_PATH"
fi

if [ ! -f "$MODEL_PATH" ]; then
  URL="https://huggingface.co/$REPO/resolve/$REVISION/$FILE"
  echo "hearth_judge: downloading $FILE from $REPO@$REVISION (one-time, into /data) ..."
  TMP="$MODEL_PATH.part"
  rm -f "$TMP"
  curl -fL --retry 3 --retry-connrefused -o "$TMP" "$URL"
  printf '%s  %s\n' "$SHA256" "$TMP" | sha256sum -c -
  mv "$TMP" "$MODEL_PATH"
  echo "hearth_judge: model verified and saved to $MODEL_PATH."
fi

ARGS=(
  -m "$MODEL_PATH"
  --host 0.0.0.0 --port 8080
  -np 1
  -t "$THREADS" -tb "$THREADS"
  --poll 0
  -c "$CTX_SIZE"
  --cache-prompt --cache-reuse 256
  --slot-save-path "$SLOT_DIR"
  --no-webui
  --metrics
  --jinja
  --temp 0
)
if [ -n "$API_KEY" ]; then
  ARGS+=(--api-key "$API_KEY")
fi

echo "hearth_judge: starting llama-server (model=$MODEL_KEY threads=$THREADS ctx_size=$CTX_SIZE parallel=1, API key $([ -n "$API_KEY" ] && echo set || echo unset))."
exec /app/llama-server "${ARGS[@]}"
