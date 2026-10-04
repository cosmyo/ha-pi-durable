#!/bin/sh
# Trusted operator only, on the Docker host. This is NOT an agent tool.
# Requires an installed/running configured Hearth App and a locally built worker image.
set -eu
slug=${1:?Usage: install-workspace.sh CONTROLLER_SLUG WORKER_IMAGE}
image=${2:?Worker image is required}
case "$slug" in *_hearth_pi) ;; *) echo "Not a Hearth controller slug" >&2; exit 1;; esac
case "$slug$image" in *[!a-zA-Z0-9_:./-]*) echo "Invalid argument" >&2; exit 1;; esac
name=hearth-pi-workspace
volume=hearth-pi-workspace-files
if docker container inspect "$name" >/dev/null 2>&1; then
  echo "Worker already exists. Inspect it; this script never silently replaces a container." >&2; exit 1
fi
# Current Supervisor uses app_; older versions used addon_. Never infer from a
# broad name substring or silently choose between two matching controllers.
controller=
for candidate in "app_$slug" "addon_$slug"; do
  if docker container inspect "$candidate" >/dev/null 2>&1; then
    test -z "$controller" || { echo "Ambiguous Hearth controller" >&2; exit 1; }
    controller=$candidate
  fi
done
test -n "$controller" || { echo "Hearth controller not found" >&2; exit 1; }
# ONLY the controller's own addon_config mapping, never HA Core's /config or /data.
source=$(docker inspect "$controller" --format '{{range .Mounts}}{{if eq .Destination "/workspace_link"}}{{.Source}}{{end}}{{end}}')
test -n "$source"
# Check through Docker: the SSH App's filesystem is not the HAOS host filesystem.
docker run --rm --network none --read-only --user 1001:1000 --cap-drop ALL --security-opt no-new-privileges=true \
  --mount "type=bind,source=$source/bridge,target=/run/hearth-bridge,readonly" \
  --entrypoint /bin/sh "$image" -c 'test -f /run/hearth-bridge/key'
if ! docker volume inspect "$volume" >/dev/null 2>&1; then
  docker volume create "$volume" >/dev/null
  # Only initialize the empty private volume; never recursively chown existing user files.
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges=true \
    --mount "type=volume,source=$volume,target=/workspace,volume-nocopy" --entrypoint /bin/sh "$image" \
    -c 'chmod 0700 /workspace && chown 1001:1000 /workspace'
fi
docker run -d --name "$name" --label org.hearth-pi.role=isolated-workspace --restart unless-stopped --init \
  --network none --read-only --user 1001:1000 --cap-drop ALL \
  --security-opt no-new-privileges=true --security-opt apparmor=docker-default \
  --pids-limit 128 --memory 512m --cpus 2 --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --mount "type=bind,source=$source/bridge,target=/run/hearth-bridge" \
  --mount "type=volume,source=$volume,target=/workspace,volume-nocopy" "$image" >/dev/null
echo "Worker created. Verify flags, denied egress/mounts and tool execution before relying on it."
