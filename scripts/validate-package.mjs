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
assert.equal(config.panel_title, "Hearth Pi");
assert.equal(config.panel_icon, "mdi:fire");
const repository = parse(await read("repository.yaml"));
assert.equal(repository.url, config.url);
assert.equal(config.backup, "cold");
assert.equal(config.init, true);
for (const field of [
  "ports",
  "webui",
  "image",
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
assert.deepEqual(config.map, [
  { type: "addon_config", read_only: false, path: "/workspace_link" },
]);
assert.equal(config.options.workspace_enabled, false);
assert.equal(config.options.anthropic_auth_enabled, false);
assert.equal(config.schema.anthropic_auth_enabled, "bool");
assert.equal(pkg.dependencies["@gotgenes/pi-anthropic-auth"], "3.4.2");
assert.equal(pkg.dependencies.jiti, "2.7.0");
assert.deepEqual(config.options.authorized_user_ids, []);
assert.deepEqual(config.options.allowed_entities, []);
assert.deepEqual(config.options.allowed_services, []);
assert.equal(config.options.service_actions_enabled, false);
// Admin access mode is owner opt-in and never needs a Supervisor role.
assert.equal(config.options.access_mode, "scoped");
assert.equal(config.schema.access_mode, "list(scoped|admin)");
assert.equal(config.options.risk_judge_model, "auto");
assert.equal(config.schema.risk_judge_api_key, "password");
assert.deepEqual(
  Object.keys(config.options).sort(),
  Object.keys(config.schema).sort(),
);
for (const name of [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/chord",
  "@earendil-works/pi-coding-agent",
])
  assert.equal(pkg.dependencies[name], "1.0.1");
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
// Bundled skills ship in the image and each has its frontmatter.
assert.match(docker, /^COPY skills \.\/skills$/m);
for (const name of ["home-world-setup"]) {
  const skill = await read(`hearth_pi/skills/${name}/SKILL.md`);
  assert.match(
    skill,
    new RegExp(`^---\nname: ${name}\ndescription: .+\n---\n`),
  );
}
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
for (const file of [
  "app.js",
  "apps.js",
  "today.js",
  "render.js",
  // Home World modules (loaded on demand).
  "world/world.js",
  "world/house.js",
  "world/strip.js",
]) {
  const result = spawnSync(process.execPath, [
    "--check",
    `hearth_pi/public/${file}`,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
}
const readme = await read("README.md");
assert(readme.includes(config.version));
const installLink = new URL(
  "https://my.home-assistant.io/redirect/supervisor_add_addon_repository/",
);
installLink.searchParams.set("repository_url", repository.url);
for (const [path, content] of [
  ["README.md", readme],
  ["hearth_pi/DOCS.md", await read("hearth_pi/DOCS.md")],
]) {
  assert(
    content.includes(installLink.href),
    `${path}: missing repository link`,
  );
  for (const instruction of ["Show in sidebar", "allowed_entities"])
    assert(content.includes(instruction), `${path}: missing ${instruction}`);
}
console.log(
  "App packaging: manifest defaults/permissions, versions, exact pins/lockfile, complete local build context and browser syntax verified. Container execution is a separate gate.",
);

// --- hearth_judge: the second, local llama.cpp risk-judge add-on. ---
const judgeConfig = parse(await read("hearth_judge/config.yaml"));
assert.equal(judgeConfig.slug, "hearth_judge");
assert.deepEqual(judgeConfig.arch, ["aarch64", "amd64"]);
assert.equal(judgeConfig.url, repository.url);
assert.equal(judgeConfig.stage, "experimental");
assert.equal(judgeConfig.backup, "cold");
// Reachable only on the internal hassio network: no port/ingress/HA-API/
// Supervisor-admin/host surface at all.
for (const field of [
  "ports",
  "webui",
  "image",
  "ingress",
  "ingress_port",
  "panel_admin",
  "hassio_api",
  "hassio_role",
  "homeassistant_api",
  "auth_api",
  "docker_api",
  "host_network",
  "host_dbus",
  "host_pid",
  "full_access",
  "privileged",
  "devices",
  "map",
])
  assert(
    !Object.hasOwn(judgeConfig, field),
    `hearth_judge/config.yaml: unexpected permission ${field}`,
  );
assert.deepEqual(
  Object.keys(judgeConfig.options).sort(),
  Object.keys(judgeConfig.schema).sort(),
);
const judgeModels = JSON.parse(await read("hearth_judge/models.json"));
const modelKeys = Object.keys(judgeModels);
assert(modelKeys.length > 0, "hearth_judge/models.json: no models listed");
assert.equal(
  judgeConfig.schema.model,
  `list(${modelKeys.join("|")})`,
  "hearth_judge/config.yaml schema.model must list exactly models.json's keys",
);
assert(
  modelKeys.includes(judgeConfig.options.model),
  "hearth_judge/config.yaml options.model must be one of models.json's keys",
);
for (const [key, entry] of Object.entries(judgeModels)) {
  for (const field of ["label", "repo", "revision", "file", "sha256"])
    assert(
      typeof entry[field] === "string" && entry[field].length > 0,
      `hearth_judge/models.json: ${key}.${field} missing`,
    );
  // A real, pinned, lower-case sha256 — never a "TODO" placeholder. run.sh
  // additionally refuses to start on any model whose pin fails this same
  // check, so a future unverified entry cannot silently ship.
  assert.match(
    entry.sha256,
    /^[0-9a-f]{64}$/,
    `hearth_judge/models.json: ${key}.sha256 is not a verified 64-char hex digest`,
  );
  assert.match(
    entry.revision,
    /^[0-9a-f]{40}$/,
    `hearth_judge/models.json: ${key}.revision is not a pinned 40-char git commit`,
  );
}
const judgeDockerfile = await read("hearth_judge/Dockerfile");
// Pinned by digest, never the floating ":server" tag alone.
assert.match(
  judgeDockerfile,
  /FROM ghcr\.io\/ggml-org\/llama\.cpp:server@sha256:[a-f0-9]{64}/,
);
assert.match(judgeDockerfile, /ENTRYPOINT \[\]/);
assert.match(judgeDockerfile, /CMD \["\/run\.sh"\]/);
const judgeRun = await read("hearth_judge/run.sh");
// Verifies, never trusts, the downloaded model; refuses to start without a
// pinned hash; never opens the Web UI; hardcodes the single-slot design so
// the cached policy prefix stays valid (not an owner-configurable option).
for (const must of [
  "sha256sum -c",
  "refusing to start",
  "--no-webui",
  "-np 1",
  "--cache-prompt",
  "gosu",
])
  assert(
    judgeRun.includes(must),
    `hearth_judge/run.sh: missing expected "${must}"`,
  );
for (const file of [
  "README.md",
  "DOCS.md",
  "CHANGELOG.md",
  "LICENSE",
  ".dockerignore",
])
  await access(`hearth_judge/${file}`);
console.log(
  "hearth_judge packaging: manifest permissions/options, pinned image digest and sha256-verified model list, and run.sh's refuse-without-a-hash/no-webui/single-slot invariants verified. Container execution is a separate gate.",
);
