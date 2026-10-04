#!/bin/sh
# Isolated local/CI container gate only. No HA connection, publishing or public ports.
set -eu
arch="${1:-amd64}"
case "$arch" in amd64) platform=linux/amd64 ;; aarch64) platform=linux/arm64 ;; *) echo 'Expected amd64 or aarch64' >&2; exit 1 ;; esac
docker info >/dev/null
node scripts/validate-package.mjs
image="hearth-pi-smoke:$arch"
name="hearth-pi-smoke-$$"
data="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker run --rm --user 0:0 --entrypoint node -v "$data:/fixture" "$image" -e 'require("fs").rmSync("/fixture",{recursive:true,force:true})' >/dev/null 2>&1 || true; rmdir "$data" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
printf '%s\n' '{"authorized_user_ids":["synthetic-admin"],"service_actions_enabled":false,"allowed_services":[],"allowed_entities":[],"public_origin":"https://home.example","provider":"offline","model":"faux","openai_api_key":""}' > "$data/options.json"
chmod 600 "$data/options.json"
docker build --platform "$platform" --build-arg "BUILD_ARCH=$arch" --build-arg BUILD_VERSION=0.2.0 -t "$image" hearth_pi
docker run -d --name "$name" --init --network none -v "$data:/data" "$image" >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker logs "$name" 2>&1 | grep -q 'Hearth Pi ready'; then break; fi
  sleep 1
done
docker exec --user 1000:1000 "$name" node --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
// --init owns PID 1; inspect the Node process from the init child list.
const pid = fs.readFileSync("/proc/1/task/1/children","utf8").trim().split(" ")[0];
assert.match(fs.readFileSync(`/proc/${pid}/status`,"utf8"),/Uid:\s+1000\s+1000\s+1000\s+1000/);
const stat = fs.statSync("/data/hearth.sqlite"); assert.equal(stat.uid,1000); assert.equal(stat.mode & 0o777,0o600);
const r = await fetch("http://127.0.0.1:8099/api/bootstrap",{headers:{"X-Remote-User-Id":"synthetic-admin","X-Forwarded-For":"172.30.32.2"}});
assert.equal(r.status,403);
console.log("Container: root-owned options read before UID drop; private data created; forged local Ingress rejected.");'
docker stop --time 30 "$name" >/dev/null
code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
[ "$code" = 0 ] || { echo "Graceful stop failed: $code" >&2; exit 1; }
docker start "$name" >/dev/null
sleep 2
docker logs "$name" 2>&1 | grep -q 'Hearth Pi ready'
docker stop --time 30 "$name" >/dev/null
printf '%s\n' "Container $arch build, UID/data/forged-Ingress smoke, restart and graceful stop passed. Real Supervisor Ingress remains a separate deployment test."
