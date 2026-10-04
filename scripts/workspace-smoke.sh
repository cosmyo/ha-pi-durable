#!/bin/sh
# Synthetic native Linux Docker test; never connects to HA or a model account.
set -eu
arch=${1:-amd64}
case "$arch" in amd64) platform=linux/amd64;; aarch64) platform=linux/arm64;; *) exit 1;; esac
image="hearth-pi-workspace-smoke:$arch"
name="hearth-workspace-smoke-$$"
volume="hearth-workspace-smoke-files-$$"
fixture=$(mktemp -d)
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; docker run --rm --user 0:0 --entrypoint node -v "$fixture:/fixture" "$image" -e 'require("fs").rmSync("/fixture",{recursive:true,force:true})' >/dev/null 2>&1 || true; rmdir "$fixture" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
mkdir "$fixture/bridge"
node -e 'require("fs").writeFileSync(process.argv[1],"a".repeat(64))' "$fixture/bridge/key"
docker build --platform "$platform" -f hearth_pi/Dockerfile.workspace -t "$image" hearth_pi
docker volume create "$volume" >/dev/null
docker run --rm --user 0:0 --entrypoint node -v "$fixture:/fixture" \
  --mount "type=volume,source=$volume,target=/workspace,volume-nocopy" "$image" \
  -e 'const fs=require("fs");fs.chownSync("/fixture/bridge",1001,1000);fs.chmodSync("/fixture/bridge",0o750);fs.chmodSync("/workspace",0o700);fs.chownSync("/workspace",1001,1000);fs.chownSync("/fixture/bridge/key",1001,1000);fs.chmodSync("/fixture/bridge/key",0o440)'
docker run -d --name "$name" --init --network none --read-only --user 1001:1000 --cap-drop ALL \
  --security-opt no-new-privileges=true --security-opt apparmor=docker-default \
  --pids-limit 128 --memory 512m --cpus 2 --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  -v "$fixture/bridge:/run/hearth-bridge" --mount "type=volume,source=$volume,target=/workspace,volume-nocopy" "$image" >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker logs "$name" 2>&1 | grep -q 'worker ready'; then break; fi
  sleep 1
done
docker logs "$name" 2>&1 | grep -q 'worker ready'
docker exec "$name" node --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
import {WorkspaceClient} from "/app/dist/workspace.js";
import {verifyWorkerIsolation} from "/app/dist/worker.js";
await verifyWorkerIsolation();
assert(!fs.existsSync("/data/options.json"));assert(!fs.existsSync("/var/run/docker.sock"));
for(const key of ["SUPERVISOR_TOKEN","HA_KEY","OPENAI_API_KEY"]) assert(!process.env[key]);
const c=new WorkspaceClient("/run/hearth-bridge/worker.sock",fs.readFileSync("/run/hearth-bridge/key","utf8"));
assert.equal((await c.call("write",{path:"proof.py",content:"assert 3 + 4 == 7\nprint(\"PASS: isolated Pi tools\")\n"})).isError,false);
assert.equal((await c.call("edit",{path:"proof.py",edits:[{oldText:"3 + 4",newText:"2 + 5"}]})).isError,false);
assert.match(JSON.stringify(await c.call("read",{path:"proof.py"})),/2 \+ 5/);
assert.match(JSON.stringify(await c.call("bash",{command:"python3 proof.py",timeout:5})),/PASS: isolated Pi tools/);
await assert.rejects(fs.promises.writeFile("/app/forbidden","no"));
assert(Object.keys((await import("node:os")).networkInterfaces()).every(n=>n==="lo"));
const route=fs.readFileSync("/proc/net/route","utf8").trim().split("\n");assert.equal(route.length,1);
console.log("Genuine Pi read/write/edit/bash passed; non-root, zero capabilities, no-new-privs, seccomp, enforcing AppArmor, readonly rootfs, no routes/HA/Docker credentials or mounts.");'
printf '%s\n' "Native $arch isolated workspace gate passed. This is not a Supervisor deployment or live model test."
