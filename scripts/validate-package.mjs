import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parse } from "../hearth_pi/node_modules/yaml/dist/index.js";
const read = (path) => readFile(path, "utf8");
const config = parse(await read("hearth_pi/config.yaml"));
const pkg = JSON.parse(await read("hearth_pi/package.json"));
const root = JSON.parse(await read("package.json"));
assert.equal(config.version, pkg.version);
assert.equal(root.version, pkg.version);
assert.deepEqual(config.arch, ["aarch64", "amd64"]);
assert.equal(config.ingress, true);
assert.equal(config.ingress_port, 8099);
assert.equal(config.homeassistant_api, true);
assert.equal(config.panel_admin, true);
assert.equal(config.backup, "cold");
assert.equal(config.init, true);
for (const field of [
  "ports",
  "webui",
  "image",
  "map",
  "hassio_api",
  "hassio_role",
  "auth_api",
  "docker_api",
  "host_network",
  "host_dbus",
  "host_pid",
  "full_access",
  "privileged",
  "devices",
])
  assert(!Object.hasOwn(config, field), `Unexpected permission ${field}`);
assert.deepEqual(config.options.authorized_user_ids, []);
assert.deepEqual(config.options.allowed_entities, []);
assert.deepEqual(config.options.allowed_services, []);
assert.equal(config.options.service_actions_enabled, false);
assert.deepEqual(
  Object.keys(config.options).sort(),
  Object.keys(config.schema).sort(),
);
for (const name of [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/chord",
])
  assert.equal(pkg.dependencies[name], "1.0.0");
const lock = JSON.parse(await read("hearth_pi/package-lock.json"));
for (const [name, version] of Object.entries({
  ...pkg.dependencies,
  ...pkg.devDependencies,
}))
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
const docker = await read("hearth_pi/Dockerfile");
assert(!docker.includes("COPY .."));
assert.match(docker, /node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64}/);
assert.match(docker, /npm ci/);
assert.match(docker, /CMD \["node", "dist\/main.js"\]/);
assert.match(docker, /io.hass.type="app"/);
for (const file of [
  "README.md",
  "DOCS.md",
  "CHANGELOG.md",
  "LICENSE",
  "icon.png",
  "logo.png",
  ".dockerignore",
])
  await access(`hearth_pi/${file}`);
for (const file of ["app.js", "render.js"]) {
  const result = spawnSync(process.execPath, [
    "--check",
    `hearth_pi/public/${file}`,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
}
const readme = await read("README.md");
assert(readme.includes("0.1.0"));
console.log(
  "App packaging: manifest defaults/permissions, versions, exact pins/lockfile, complete local build context and browser syntax verified. Container execution is a separate gate.",
);
