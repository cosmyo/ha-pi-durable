/* PROTOTYPE — Home World variant B "Diorama" (throwaway exploration).
 * A low-poly, cut-away dollhouse in three.js (vendored locally, see
 * docs/third-party.md). Orthographic camera; drag to orbit, pinch/wheel to
 * zoom, two fingers to pan, tap a device to focus it. Chat is a bottom
 * sheet over the scene. Renders only on change or while animating, caps
 * devicePixelRatio at 2 and pauses when hidden. All geometry is original.
 */
import * as THREE from "../vendor/three/three.module.js";
import {
  GRID,
  PALETTES,
  el,
  button,
  clamp,
  hash32,
  reducedMotion,
  roomAt,
  wallsOf,
  placeDevices,
  placementFor,
  createActors,
  createEditPanel,
} from "./prototype-world.js";

const FLOOR_COLORS = {
  wood: ["#b9794a", "#95592f"],
  tile: ["#f1e9d6", "#d8cbb0"],
  carpet: ["#6d7dab", "#8292c2"],
  stone: ["#9a9a93", "#83837c"],
  grass: ["#5e9c4a", "#76b85f"],
};
const toWorld = (x, y) =>
  new THREE.Vector3(x - GRID.cols / 2, 0, y - GRID.rows / 2);

function floorTexture(style) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const [base, accent] = FLOOR_COLORS[style] ?? FLOOR_COLORS.wood;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  g.fillStyle = accent;
  if (style === "wood")
    for (let i = 0; i < 4; i++)
      (g.fillRect(0, i * 8 + 7, size, 1),
        g.fillRect((i * 11) % size, i * 8, 1, 7));
  else if (style === "tile")
    (g.fillRect(0, 0, 16, 16), g.fillRect(16, 16, 16, 16));
  else if (style === "carpet")
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++)
        if ((i + j) % 2 === 0) g.fillRect(i * 4 + 1, j * 4 + 1, 1, 1);
        else if (style === "stone")
          (g.fillRect(0, 15, size, 1),
            g.fillRect(10, 0, 1, 15),
            g.fillRect(24, 16, 1, 16));
        else
          for (let i = 0; i < 10; i++)
            g.fillRect(
              hash32(`g${i}`) % size,
              (hash32(`h${i}`) >> 3) % size,
              1,
              2,
            );
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d");
  const gradient = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,210,120,0.85)");
  gradient.addColorStop(1, "rgba(255,210,120,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createVariant(ctx) {
  const { overlay, store } = ctx;
  const motion = !reducedMotion();
  let world = null,
    devices = [],
    selected = null,
    editing = false,
    editPanel = null,
    expanded = false;
  const shell = el("div", { className: "dio-shell" });
  const stage = el("div", { className: "dio-stage" });
  const labels = el("div", {
    className: "dio-labels",
    attrs: { "aria-hidden": "true" },
  });
  const title = el("span", { className: "dio-title", text: "Home World" });
  const hint = el("span", {
    className: "dio-hint",
    text: "Drag to orbit · pinch to zoom",
  });
  const editButton = button("Edit home", "dio-edit-toggle");
  editButton.setAttribute("aria-pressed", "false");
  const recenter = button("⌖", "dio-recenter", "Recenter view");
  const header = el("div", { className: "dio-header" }, [
    el("div", {}, [title, hint]),
    recenter,
    editButton,
  ]);
  const handle = button("", "dio-handle");
  handle.setAttribute("aria-expanded", "false");
  const card = el("div", { className: "dio-card", attrs: { hidden: "" } });
  const lines = el("div", {
    className: "dio-lines",
    attrs: {
      role: "log",
      "aria-label": "Latest conversation",
      "aria-live": "polite",
    },
  });
  const status = el("p", {
    className: "dio-status",
    attrs: { role: "status" },
  });
  const sheet = el(
    "section",
    { className: "dio-sheet", attrs: { "aria-label": "Hearth chat" } },
    [handle, card, lines, status],
  );
  const deviceList = el("div", {
    className: "sr-only dio-device-list",
    attrs: { role: "list", "aria-label": "Devices in the diorama" },
  });
  shell.append(stage, labels, header, sheet, deviceList);
  overlay.append(shell);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    stage.append(
      el("p", {
        className: "dio-fallback",
        text: "This prototype needs WebGL, which is unavailable here.",
      }),
    );
    return { update() {}, destroy: () => shell.remove() };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor("#16201f");
  stage.append(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "3D diorama of your home (prototype)",
  );
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#fff4e2", "#3b4a40", 2.2));
  const sun = new THREE.DirectionalLight("#ffffff", 1.6);
  sun.position.set(6, 12, 8);
  scene.add(sun);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshLambertMaterial({ color: "#26352a" }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.21;
  scene.add(ground);
  const house = new THREE.Group();
  const deviceGroup = new THREE.Group();
  scene.add(house, deviceGroup);
  const textures = Object.fromEntries(
    Object.keys(FLOOR_COLORS).map((k) => [k, floorTexture(k)]),
  );
  const glowMap = glowTexture();
  const material = (color, extra = {}) =>
    new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const box = (w, h, d, color) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));

  // ---------------------------------------------------------- camera
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const view = {
    theta: Math.PI / 4,
    phi: 0.72,
    zoom: 1,
    target: new THREE.Vector3(0, 0, 0),
  };
  let tween = null;
  function placeCamera() {
    const width = stage.clientWidth || 1,
      height = stage.clientHeight || 1,
      aspect = width / height;
    const half = Math.max(6.5, 10.5 / aspect);
    camera.left = -half * aspect;
    camera.right = half * aspect;
    // Shift the framing up so the house sits above the chat/edit sheet.
    const lift = half * (editing ? 0.42 : 0.28);
    camera.top = half - lift;
    camera.bottom = -half - lift;
    camera.zoom = view.zoom;
    const offset = new THREE.Vector3(
      Math.cos(view.phi) * Math.sin(view.theta),
      Math.sin(view.phi),
      Math.cos(view.phi) * Math.cos(view.theta),
    ).multiplyScalar(40);
    camera.position.copy(view.target).add(offset);
    camera.lookAt(view.target);
    camera.updateProjectionMatrix();
    cutaway();
  }
  // Dollhouse cut-away: outside walls facing the camera drop to a low skirt.
  let walls = [];
  function cutaway() {
    const facing = new THREE.Vector3(
      Math.sin(view.theta),
      0,
      Math.cos(view.theta),
    );
    for (const wall of walls) {
      const low = wall.interior
        ? 0.45
        : wall.normal.dot(facing) > 0.2
          ? 0.18
          : 1.3;
      wall.mesh.scale.y = low;
      wall.mesh.position.y = low / 2;
    }
  }

  // ---------------------------------------------------------- house build
  function furnish(room) {
    const items = [];
    const at = (x, y) => toWorld(room.x + x, room.y + y);
    const add = (mesh, x, y, h) => {
      mesh.position.copy(at(x, y));
      mesh.position.y = h;
      items.push(mesh);
    };
    const name = room.name.toLowerCase();
    if (/living|lounge/.test(name)) {
      add(box(2.6, 0.04, 1.6, "#d1b07a"), room.w / 2, room.h / 2, 0.02);
      add(box(2.4, 0.45, 0.8, "#7c4d70"), room.w / 2, room.h - 0.7, 0.22);
      add(box(1.6, 0.8, 0.15, "#2a2f36"), room.w / 2, 0.3, 0.6);
    } else if (/kitchen/.test(name)) {
      add(box(room.w - 0.4, 0.8, 0.7, "#ddd6c7"), room.w / 2, 0.45, 0.4);
      add(box(0.8, 1.6, 0.7, "#e9eef0"), room.w - 0.6, 1.3, 0.8);
      add(box(1.2, 0.7, 0.9, "#b3774a"), room.w / 2, room.h / 2 + 0.6, 0.35);
    } else if (/office|study/.test(name)) {
      add(box(1.8, 0.7, 0.7, "#93633f"), Math.min(1.4, room.w / 2), 0.5, 0.35);
      add(
        box(0.7, 0.45, 0.06, "#5fc7f0"),
        Math.min(1.4, room.w / 2),
        0.4,
        0.95,
      );
      add(box(0.5, 1.8, 0.4, "#6b4529"), room.w - 0.4, room.h - 0.8, 0.9);
    } else if (/bed/.test(name)) {
      add(box(1.6, 0.45, 2.4, "#577cb4"), 1.2, 1.6, 0.22);
      add(box(1.4, 0.15, 0.4, "#ffffff"), 1.2, 0.6, 0.5);
      add(box(0.5, 0.5, 0.5, "#7b5534"), 2.3, 0.6, 0.25);
    } else if (/patio|garden|outdoor/.test(name)) {
      add(box(1.8, 0.4, 0.5, "#8d5b34"), room.w / 2, room.h / 2, 0.2);
      for (let i = 0; i < 4; i++) {
        const r = hash32(`${room.id}${i}`);
        const bush = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.35, 0),
          material(i % 2 ? "#4f9b4b" : "#3f8441"),
        );
        add(
          bush,
          0.6 + ((r % 100) / 100) * (room.w - 1.2),
          0.6 + (((r >> 8) % 100) / 100) * (room.h - 1.2),
          0.3,
        );
      }
    } else {
      add(box(1.2, 0.04, 0.8, "#b28a5c"), room.w / 2, room.h / 2, 0.02);
    }
    const pot = box(0.35, 0.3, 0.35, "#a25b3a");
    const leaves = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 0),
      material("#3f8441"),
    );
    leaves.position.y = 0.35;
    pot.add(leaves);
    add(pot, 0.45, room.h - 0.45, 0.15);
    return items;
  }
  function buildHouse() {
    for (const child of [...house.children]) {
      house.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose?.();
      });
    }
    walls = [];
    const layout = store.get();
    const selectedRoom = editPanel?.selectedRoom();
    for (const room of layout.rooms) {
      const map = textures[room.floor] ?? textures.wood;
      const floorMaterial = new THREE.MeshLambertMaterial({
        map: map.clone(),
        color: room.id === selectedRoom && editing ? "#ffe2c4" : "#ffffff",
      });
      floorMaterial.map.repeat.set(room.w, room.h);
      floorMaterial.map.needsUpdate = true;
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(room.w, 0.2, room.h),
        floorMaterial,
      );
      floor.position.copy(toWorld(room.x + room.w / 2, room.y + room.h / 2));
      floor.position.y = -0.1;
      house.add(floor, ...furnish(room));
    }
    const normals = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (const wall of wallsOf(layout)) {
      const length = wall.to - wall.from;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(
          wall.vertical ? 0.14 : length + 0.14,
          1,
          wall.vertical ? length + 0.14 : 0.14,
        ),
        material("#efe2c8"),
      );
      const mid = wall.from + length / 2;
      mesh.position.copy(
        wall.vertical ? toWorld(wall.at, mid) : toWorld(mid, wall.at),
      );
      const [nx, nz] = normals[wall.side];
      const probe = wall.vertical
        ? { x: wall.at + nx * 0.5, y: mid }
        : { x: mid, y: wall.at + nz * 0.5 };
      walls.push({
        mesh,
        normal: new THREE.Vector3(nx, 0, nz),
        interior: !!roomAt(layout, probe.x, probe.y),
      });
      house.add(mesh);
    }
    cutaway();
  }

  // ---------------------------------------------------------- devices
  const deviceMeshes = new Map();
  let deviceSignature = "";
  function deviceMesh(d) {
    const group = new THREE.Group();
    const parts = {};
    if (d.kind === "light" || d.kind === "switch" || d.kind === "fan") {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6),
        material("#5c5048"),
      );
      pole.position.y = 0.5;
      const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.3, 0.3, 8),
        material("#b0a99c"),
      );
      shade.position.y = 1.1;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.22, 0.06, 8),
        material("#3c3530"),
      );
      base.position.y = 0.03;
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 24),
        new THREE.MeshBasicMaterial({
          map: glowMap,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.02;
      group.add(pole, shade, base, glow);
      Object.assign(parts, { shade, glow });
    } else if (d.kind === "climate") {
      const unit = box(0.5, 0.9, 0.35, "#eef1f2");
      unit.position.y = 0.45;
      const strip = box(0.4, 0.06, 0.37, "#9aa3a7");
      strip.position.y = 0.75;
      group.add(unit, strip);
      parts.strip = strip;
    } else if (d.kind === "printer") {
      const base = box(0.6, 0.12, 0.6, "#2f3338");
      base.position.y = 0.06;
      for (const [x, z] of [
        [-0.26, -0.26],
        [0.26, -0.26],
        [-0.26, 0.26],
        [0.26, 0.26],
      ]) {
        const post = box(0.05, 0.7, 0.05, "#c4c9cf");
        post.position.set(x, 0.45, z);
        group.add(post);
      }
      const top = box(0.6, 0.05, 0.6, "#c4c9cf");
      top.position.y = 0.8;
      const nozzle = box(0.12, 0.12, 0.12, "#e07a3a");
      nozzle.position.y = 0.45;
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 6, 4),
        new THREE.MeshBasicMaterial({ color: "#7dff9a" }),
      );
      led.position.set(0.25, 0.14, 0.31);
      group.add(base, top, nozzle, led);
      Object.assign(parts, { nozzle, led });
    } else if (d.kind === "media") {
      const screen = box(1.0, 0.6, 0.06, "#2c333c");
      screen.position.y = 0.7;
      const stand = box(0.1, 0.4, 0.1, "#1f2329");
      stand.position.y = 0.2;
      group.add(screen, stand);
      parts.screen = screen;
    } else {
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.08, 0.5, 6),
        material("#5c5048"),
      );
      stand.position.y = 0.25;
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, 0.1, 10),
        material(d.kind === "thermo" ? "#f4f6f6" : "#dfe6e8"),
      );
      puck.position.y = 0.55;
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 6, 4),
        new THREE.MeshBasicMaterial({
          color: d.kind === "thermo" ? "#e0503c" : "#5fb7a0",
        }),
      );
      led.position.y = 0.62;
      group.add(stand, puck, led);
    }
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.3, 0.9),
      new THREE.MeshBasicMaterial(),
    );
    hit.visible = false;
    hit.position.y = 0.6;
    hit.userData.entityId = d.entityId;
    group.add(hit);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.68, 24),
      new THREE.MeshBasicMaterial({
        color: "#ffc58e",
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.visible = false;
    group.add(ring);
    Object.assign(parts, { hit, ring });
    return { group, parts };
  }
  function syncDevices() {
    const signature = devices.map((d) => `${d.entityId}:${d.kind}`).join("|");
    if (signature !== deviceSignature) {
      deviceSignature = signature;
      for (const { group } of deviceMeshes.values()) {
        deviceGroup.remove(group);
        group.traverse((o) => {
          o.geometry?.dispose();
          o.material?.dispose?.();
        });
      }
      deviceMeshes.clear();
      for (const d of devices) {
        const mesh = deviceMesh(d);
        deviceMeshes.set(d.entityId, mesh);
        deviceGroup.add(mesh.group);
      }
    }
    for (const d of devices) {
      const { group, parts } = deviceMeshes.get(d.entityId);
      group.position.copy(toWorld(d.x, d.y));
      const unavailable = /unavailable|unknown/.test(d.state);
      if (parts.shade) {
        parts.shade.material.color.set(d.active ? "#ffe2a0" : "#9a948a");
        parts.shade.material.emissive.set(d.active ? "#ffb84a" : "#000000");
        parts.glow.visible = d.active;
      }
      if (parts.strip) {
        parts.strip.material.color.set(
          d.active ? (/heat/.test(d.state) ? "#ff9a5a" : "#7fd2ff") : "#9aa3a7",
        );
        parts.strip.material.emissive.set(
          d.active ? (/heat/.test(d.state) ? "#7a2e10" : "#1d5a7a") : "#000000",
        );
      }
      if (parts.screen)
        parts.screen.material.emissive.set(d.active ? "#3b2fa0" : "#000000");
      if (parts.led && d.kind === "printer")
        parts.led.material.color.set(
          unavailable
            ? "#e05a4a"
            : /print|busy|running/.test(d.state)
              ? "#ffb347"
              : "#7dff9a",
        );
      parts.ring.visible =
        d.entityId === world?.focus?.entityId || d.entityId === selected;
    }
    deviceList.replaceChildren(
      ...devices.map((d) => {
        const item = button(`${d.name}: ${d.value}`, "");
        item.setAttribute("role", "listitem");
        item.addEventListener("click", () => focusDevice(d.entityId));
        return item;
      }),
    );
  }

  // ---------------------------------------------------------- characters
  const actors = createActors(store.get());
  const skin = material("#f1c7a0");
  let hearthMesh = null,
    lookSignature = "";
  function buildHearth(look) {
    if (hearthMesh) scene.remove(hearthMesh.group);
    const palette = PALETTES[look.palette] ?? PALETTES[0];
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.22, 0.5, 8),
      material(palette.body),
    );
    body.position.y = 0.45;
    const belt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.205, 0.21, 0.05, 8),
      material(palette.trim),
    );
    belt.position.y = 0.38;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), skin);
    head.position.y = 0.88;
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      material(palette.hair),
    );
    hair.position.y = 0.9;
    hair.rotation.x = -0.35;
    const eyes = box(0.16, 0.03, 0.02, "#2a2230");
    eyes.position.set(0, 0.88, 0.17);
    const legs = [-0.08, 0.08].map((x) => {
      const leg = box(0.09, 0.22, 0.09, "#352d3a");
      leg.position.set(x, 0.11, 0);
      return leg;
    });
    group.add(body, belt, head, hair, eyes, ...legs);
    if (look.hat === "beanie") {
      const hat = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        material(palette.trim),
      );
      hat.position.y = 0.95;
      const pom = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 6, 4),
        material(palette.trim),
      );
      pom.position.y = 1.16;
      group.add(hat, pom);
    } else if (look.hat === "cap") {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.19, 0.1, 10),
        material(palette.body),
      );
      cap.position.y = 1.03;
      const brim = box(0.24, 0.02, 0.16, palette.trim);
      brim.position.set(0, 0.99, 0.2);
      group.add(cap, brim);
    } else if (look.hat === "bow") {
      for (const x of [-0.06, 0.06]) {
        const loop = box(0.1, 0.08, 0.04, "#e8576a");
        loop.position.set(0.1 + x, 1.06, 0);
        loop.rotation.z = x > 0 ? 0.4 : -0.4;
        group.add(loop);
      }
    } else if (look.hat === "crown") {
      const crown = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.1, 6, 1, true),
        new THREE.MeshLambertMaterial({
          color: "#f2c94c",
          side: THREE.DoubleSide,
        }),
      );
      crown.position.y = 1.08;
      group.add(crown);
    }
    scene.add(group);
    hearthMesh = { group, legs };
  }
  const pet = new THREE.Group();
  {
    const body = box(0.42, 0.2, 0.22, "#c48a4a");
    body.position.y = 0.2;
    const head = box(0.18, 0.18, 0.18, "#d39a58");
    head.position.set(0.26, 0.32, 0);
    const ear = box(0.06, 0.08, 0.16, "#9a6533");
    ear.position.set(0.24, 0.43, 0);
    const tail = box(0.16, 0.05, 0.05, "#c48a4a");
    tail.position.set(-0.27, 0.3, 0);
    tail.rotation.z = 0.6;
    const legs = [-0.14, 0.14].map((x) => {
      const leg = box(0.06, 0.12, 0.18, "#9a6533");
      leg.position.set(x, 0.06, 0);
      return leg;
    });
    pet.add(body, head, ear, tail, ...legs);
    pet.userData.tail = tail;
  }
  scene.add(pet);
  const heading = (walker) =>
    ({ down: 0, up: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 })[
      walker.dir
    ];

  // ---------------------------------------------------------- labels
  const projected = new THREE.Vector3();
  function placeLabel(node, position, lift) {
    projected.copy(position);
    projected.y += lift;
    projected.project(camera);
    const width = stage.clientWidth,
      height = stage.clientHeight;
    node.style.left = `${((projected.x + 1) / 2) * width}px`;
    node.style.top = `${((1 - projected.y) / 2) * height}px`;
  }
  const bubble = el("p", { className: "dio-bubble" });
  function renderLabels() {
    const items = [];
    for (const d of devices) {
      if (
        !["thermo", "sensor", "climate", "printer", "binary"].includes(
          d.kind,
        ) &&
        d.entityId !== selected
      )
        continue;
      const tag = el("span", {
        className: "dio-tag",
        text: editing ? d.name : d.value,
      });
      placeLabel(tag, toWorld(d.x, d.y), 1.2);
      items.push(tag);
    }
    if (world?.busy && hearthMesh) {
      bubble.textContent = world.focus?.label ?? "Thinking…";
      placeLabel(bubble, hearthMesh.group.position, 1.5);
      items.push(bubble);
    }
    labels.replaceChildren(...items);
  }

  // ---------------------------------------------------------- render loop
  let raf = 0,
    last = performance.now(),
    visible = true,
    dirty = true;
  const invalidate = () => {
    dirty = true;
    schedule();
  };
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const layout = store.get();
    const look = layout.character;
    const signature = `${look.palette}|${look.hat}`;
    if (signature !== lookSignature) {
      lookSignature = signature;
      buildHearth(look);
      dirty = true;
    }
    const moving = actors.tick(dt, world ?? { busy: false }, layout, devices);
    if (tween) {
      const k = motion ? Math.min(1, dt * 5) : 1;
      view.target.lerp(tween.target, k);
      view.zoom += (tween.zoom - view.zoom) * k;
      if (
        view.target.distanceTo(tween.target) < 0.01 &&
        Math.abs(view.zoom - tween.zoom) < 0.01
      )
        tween = null;
      placeCamera();
      dirty = true;
    }
    const time = now / 1000;
    hearthMesh.group.position.copy(toWorld(actors.hearth.x, actors.hearth.y));
    hearthMesh.group.rotation.y = heading(actors.hearth);
    const swing = actors.hearth.moving
      ? Math.sin(actors.hearth.phase) * 0.5
      : 0;
    hearthMesh.legs[0].rotation.x = swing;
    hearthMesh.legs[1].rotation.x = -swing;
    hearthMesh.group.position.y =
      !actors.hearth.moving && world?.busy && motion
        ? Math.abs(Math.sin(time * 3)) * 0.05
        : 0;
    pet.visible = layout.pet;
    pet.position.copy(toWorld(actors.pet.x, actors.pet.y));
    pet.rotation.y = heading(actors.pet) - Math.PI / 2;
    if (motion) pet.userData.tail.rotation.y = Math.sin(time * 10) * 0.5;
    const pulse = world?.busy || world?.focus;
    for (const d of devices) {
      const mesh = deviceMeshes.get(d.entityId);
      if (!mesh) continue;
      if (mesh.parts.ring.visible && motion)
        mesh.parts.ring.scale.setScalar(1 + Math.sin(time * 5) * 0.08);
      if (mesh.parts.nozzle && /print|busy|running/.test(d.state) && motion)
        mesh.parts.nozzle.position.x = Math.sin(time * 3) * 0.2;
    }
    if (dirty || moving || (pulse && motion)) {
      renderer.render(scene, camera);
      renderLabels();
      dirty = false;
    }
    schedule();
  }
  function schedule() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const onVisibility = () => {
    last = performance.now();
    invalidate();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    onVisibility();
  });
  intersection.observe(stage);
  const resize = new ResizeObserver(() => {
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    placeCamera();
    invalidate();
  });
  resize.observe(stage);

  // ---------------------------------------------------------- input
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointers = new Map();
  let gesture = null;
  function ray(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
  }
  function pickDevice(event) {
    ray(event);
    const hits = raycaster.intersectObjects(
      [...deviceMeshes.values()].map((m) => m.parts.hit),
      false,
    );
    return hits[0]?.object.userData.entityId ?? null;
  }
  function groundPoint(event) {
    ray(event);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, point)) return null;
    return { x: point.x + GRID.cols / 2, y: point.z + GRID.rows / 2 };
  }
  function focusDevice(entityId) {
    selected = entityId;
    const d = devices.find((x) => x.entityId === entityId);
    if (d) tween = { target: toWorld(d.x, d.y), zoom: 1.7 };
    renderCard();
    syncDevices();
    invalidate();
  }
  const canvasEl = renderer.domElement;
  canvasEl.addEventListener("pointerdown", (event) => {
    canvasEl.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      const entityId = editing ? pickDevice(event) : null;
      gesture = {
        kind: entityId ? "device" : "orbit",
        entityId,
        startX: event.clientX,
        startY: event.clientY,
        at: performance.now(),
        moved: false,
      };
    } else gesture = { kind: "pinch", moved: true };
    tween = null;
  });
  canvasEl.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !gesture) return;
    const dx = event.clientX - previous.x,
      dy = event.clientY - previous.y;
    if (
      Math.hypot(
        event.clientX - (gesture.startX ?? 0),
        event.clientY - (gesture.startY ?? 0),
      ) > 6
    )
      gesture.moved = true;
    if (gesture.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [c, d] = [...pointers.values()];
      const after = Math.hypot(c.x - d.x, c.y - d.y);
      view.zoom = clamp(view.zoom * (after / Math.max(1, before)), 0.6, 3.5);
      const scale =
        (camera.top - camera.bottom) / view.zoom / stage.clientHeight / 2;
      const right = new THREE.Vector3(
        Math.cos(view.theta),
        0,
        -Math.sin(view.theta),
      );
      const forward = new THREE.Vector3(
        -Math.sin(view.theta),
        0,
        -Math.cos(view.theta),
      );
      view.target
        .addScaledVector(right, -dx * scale)
        .addScaledVector(forward, (dy * scale) / Math.sin(view.phi));
      placeCamera();
      invalidate();
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.kind === "device") {
      const point = groundPoint(event);
      const mesh = deviceMeshes.get(gesture.entityId);
      if (point && mesh) {
        mesh.group.position.copy(
          toWorld(
            clamp(point.x, 0.3, GRID.cols - 0.3),
            clamp(point.y, 0.3, GRID.rows - 0.3),
          ),
        );
        gesture.point = point;
        invalidate();
      }
    } else if (gesture.kind === "orbit" && gesture.moved) {
      view.theta -= dx * 0.008;
      view.phi = clamp(view.phi + dy * 0.004, 0.35, 1.35);
      placeCamera();
      invalidate();
    }
  });
  const release = (event) => {
    pointers.delete(event.pointerId);
    if (!gesture) return;
    if (gesture.kind === "device" && gesture.point) {
      const place = placementFor(store.get(), gesture.point.x, gesture.point.y);
      if (place)
        store.update((layout) => (layout.devices[gesture.entityId] = place));
      else invalidate();
    } else if (
      gesture.kind !== "pinch" &&
      !gesture.moved &&
      event.type === "pointerup"
    ) {
      const entityId = pickDevice(event);
      if (entityId) focusDevice(entityId);
      else if (editing) {
        const point = groundPoint(event);
        const room = point && roomAt(store.get(), point.x, point.y);
        if (room) editPanel?.selectRoom(room.id);
      } else if (selected) {
        selected = null;
        renderCard();
        syncDevices();
        invalidate();
      }
    }
    if (!pointers.size) gesture = null;
  };
  canvasEl.addEventListener("pointerup", release);
  canvasEl.addEventListener("pointercancel", release);
  canvasEl.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.zoom = clamp(view.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.6, 3.5);
      placeCamera();
      invalidate();
    },
    { passive: false },
  );
  recenter.addEventListener("click", () => {
    tween = { target: new THREE.Vector3(0, 0, 0), zoom: 1 };
    view.theta = Math.PI / 4;
    view.phi = 0.72;
    selected = null;
    renderCard();
    invalidate();
  });

  // ---------------------------------------------------------- chat sheet
  function renderCard() {
    card.replaceChildren();
    const d = selected && devices.find((x) => x.entityId === selected);
    card.hidden = !d;
    if (!d) return;
    const ask = button("Ask Hearth about this", "dio-ask");
    ask.disabled = !world?.canDraft;
    ask.addEventListener("click", () => ctx.ask(d));
    const close = button("✕", "dio-card-close", "Close device card");
    close.addEventListener("click", () => {
      selected = null;
      renderCard();
      syncDevices();
      invalidate();
    });
    card.append(
      el("div", { className: "dio-card-head" }, [
        el("strong", { text: d.name }),
        close,
      ]),
      el("p", { className: "dio-card-value", text: d.value }),
      el("p", {
        className: "dio-card-meta",
        text: `${d.entityId} · saved HA observation ${d.observedAt ? new Date(d.observedAt).toLocaleTimeString() : ""}`,
      }),
      ask,
    );
  }
  function renderSheet() {
    handle.textContent = expanded ? "Hearth ▾" : "Hearth ▴";
    handle.setAttribute("aria-expanded", String(expanded));
    sheet.classList.toggle("dio-expanded", expanded);
    const items = [];
    if (!world?.canvas) {
      items.push(
        el("p", {
          className: "dio-hint-line",
          text:
            world?.home === false
              ? "Home World only shows Home conversations."
              : "A starter dollhouse. Ask Hearth to read your real home.",
        }),
      );
      if (world?.home !== false) {
        const build = button("Build me a home view", "dio-ask");
        build.disabled = !world?.canDraft;
        build.addEventListener("click", () => ctx.build());
        items.push(build);
      }
    }
    for (const line of (world?.lines ?? []).slice(expanded ? -8 : -2))
      items.push(
        el(
          "div",
          {
            className: `dio-line ${line.who === "You" ? "dio-you" : "dio-hearth"}`,
          },
          [
            el("span", { className: "dio-who", text: line.who }),
            el("span", { text: line.text }),
          ],
        ),
      );
    lines.replaceChildren(...items);
    lines.scrollTop = lines.scrollHeight;
    status.textContent = world?.busy ? world.status : "";
    status.hidden = !world?.busy;
    title.textContent = world?.canvas?.title ?? "Starter dollhouse";
  }
  handle.addEventListener("click", () => {
    expanded = !expanded;
    renderSheet();
  });
  function setEditing(next) {
    editing = next;
    editButton.setAttribute("aria-pressed", String(editing));
    editButton.textContent = editing ? "Editing…" : "Edit home";
    shell.classList.toggle("dio-editing", editing);
    hint.textContent = editing
      ? "Drag devices · tap a room to edit it"
      : "Drag to orbit · pinch to zoom";
    if (editing) {
      editPanel = createEditPanel(
        {
          ...ctx,
          onRoomSelected: () => {
            buildHouse();
            invalidate();
          },
        },
        { onDone: () => setEditing(false) },
      );
      editPanel.setDevices(world?.devices ?? []);
      sheet.replaceChildren(editPanel.element);
      tween = { target: new THREE.Vector3(0, 0, 0), zoom: 1 };
      view.phi = 1.25;
    } else {
      editPanel?.destroy();
      editPanel = null;
      sheet.replaceChildren(handle, card, lines, status);
      view.phi = 0.72;
      tween = { target: new THREE.Vector3(0, 0, 0), zoom: 1 };
    }
    buildHouse();
    placeCamera();
    renderLabels();
    invalidate();
  }
  editButton.addEventListener("click", () => setEditing(!editing));
  const unsubscribe = store.subscribe(() => {
    devices = placeDevices(store.get(), world?.devices ?? []);
    buildHouse();
    syncDevices();
    invalidate();
  });

  buildHouse();
  buildHearth(store.get().character);
  lookSignature = `${store.get().character.palette}|${store.get().character.hat}`;
  renderer.setSize(stage.clientWidth || 1, stage.clientHeight || 1, false);
  placeCamera();
  renderSheet();
  schedule();

  return {
    update(next) {
      world = next;
      devices = placeDevices(store.get(), world.devices);
      editPanel?.setDevices(world.devices);
      syncDevices();
      if (!editing) renderSheet();
      renderCard();
      invalidate();
    },
    destroy() {
      cancelAnimationFrame(raf);
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      editPanel?.destroy();
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
      for (const texture of Object.values(textures)) texture.dispose();
      glowMap.dispose();
      renderer.dispose();
      shell.remove();
    },
  };
}
