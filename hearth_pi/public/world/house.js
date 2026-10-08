/* Home World v1 — full-screen pixel house (top-down, 16px tiles drawn in
 * code; original art). Opened from the ambient strip or Settings → Home
 * World. Map + bottom panel (Hearth's dialogue, a device card or the editor),
 * or an accessible list view with the same actions. Devices are real DOM
 * buttons over an aria-hidden canvas.
 */
import {
  ANOMALY_TEXT,
  PALETTES,
  button,
  clamp,
  createDeviceCard,
  createEditPanel,
  createListView,
  createRenderLoop,
  createThinkActor,
  doorsOf,
  el,
  hash32,
  placementFor,
  planPath,
  recentLines,
  reducedMotion,
  roomAt,
  roomName,
  thinkLabel,
  wallsOf,
  watchVisibility,
  worldSummary,
} from "./world.js";

const T = 16;
// Smallest on-screen tile (CSS px) before a wide plan pans instead of shrinking.
const MIN_TILE_PX = 20;

// ------------------------------------------------------------ pixel art
function rect(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function floorTile(g, style, tx, ty) {
  const x = tx * T,
    y = ty * T,
    r = hash32(`${tx},${ty}`);
  if (style === "wood") {
    for (let row = 0; row < 4; row++) {
      rect(g, x, y + row * 4, T, 4, (r >> row) & 1 ? "#b9794a" : "#c3844f");
      rect(g, x, y + row * 4 + 3, T, 1, "#95592f");
      rect(
        g,
        x + ((tx * 7 + (ty * 4 + row) * 5) % 16),
        y + row * 4,
        1,
        3,
        "#9c6136",
      );
    }
  } else if (style === "tile") {
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++)
        rect(
          g,
          x + i * 8,
          y + j * 8,
          8,
          8,
          (i + j + tx + ty) % 2 ? "#e6dcc4" : "#f3ecdb",
        );
    rect(g, x, y + 15, T, 1, "#cdbf9f");
    rect(g, x + 15, y, 1, T, "#cdbf9f");
  } else if (style === "carpet") {
    rect(g, x, y, T, T, "#6d7dab");
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        if ((i + j) % 2 === 0)
          rect(g, x + i * 4 + 1, y + j * 4 + 1, 1, 1, "#8292c2");
  } else if (style === "stone") {
    rect(g, x, y, T, T, "#9a9a93");
    rect(g, x, y + 7, T, 1, "#83837c");
    rect(g, x + (ty % 2 ? 4 : 11), y, 1, 7, "#83837c");
    rect(g, x + (ty % 2 ? 12 : 6), y + 8, 1, 8, "#83837c");
  } else {
    rect(g, x, y, T, T, (r & 3) === 0 ? "#5b9748" : "#609f4c");
    for (let i = 0; i < 5; i++)
      rect(
        g,
        x + ((r >> (i * 5)) & 15),
        y + ((r >> (i * 5 + 2)) & 13),
        1,
        2,
        "#76b85f",
      );
  }
}
function plant(g, x, y) {
  rect(g, x - 4, y + 1, 8, 6, "#a25b3a");
  rect(g, x - 4, y + 1, 8, 1, "#c0744c");
  for (const [dx, dy] of [
    [-5, -4],
    [1, -6],
    [-2, -8],
    [3, -2],
    [-6, -1],
    [-1, -3],
  ])
    rect(g, x + dx, y + dy, 4, 4, dy < -5 ? "#4f9b4b" : "#3f8441");
}
// Furniture by area-name heuristics; anything else gets a plant and a rug.
function furnish(g, room) {
  const x = room.x * T,
    y = room.y * T,
    w = room.w * T,
    h = room.h * T,
    name = `${room.name} ${room.area ?? ""}`.toLowerCase();
  const fits = (tw, th) => room.w >= tw && room.h >= th;
  if (room.id === "unassigned") {
    for (let i = 0; i < Math.min(4, room.w - 2); i++) {
      rect(g, x + 6 + i * 14, y + 5, 12, 10, "#a87b4f");
      rect(g, x + 6 + i * 14, y + 9, 12, 1, "#7d5634");
    }
    rect(g, x + w - 12, y + h - 30, 8, 26, "#6b4529");
  } else if (/living|lounge|family|tv/.test(name)) {
    if (fits(5, 4)) {
      const rx = x + w / 2 - 28,
        ry = y + h / 2 - 14;
      rect(g, rx, ry, 56, 30, "#a8834f");
      rect(g, rx + 2, ry + 2, 52, 26, "#d1b07a");
      for (let i = 0; i < 4; i++)
        rect(g, rx + 6, ry + 6 + i * 5, 44, 1, "#bf9a63");
    }
    const sx = x + w / 2 - 22,
      sy = y + h - 22;
    rect(g, sx, sy, 44, 14, "#5d3a55");
    rect(g, sx + 2, sy + 2, 40, 8, "#7c4d70");
    plant(g, x + 10, y + 12);
  } else if (/kitchen|dining/.test(name)) {
    rect(g, x + 3, y + 5, w - 6, 13, "#9b9486");
    rect(g, x + 3, y + 5, w - 6, 10, "#ddd6c7");
    for (let i = 3; i < w - 6; i += 16) rect(g, x + i, y + 5, 1, 10, "#c8c0b0");
    rect(g, x + 18, y + 6, 14, 8, "#31353b");
    if (fits(4, 3)) {
      rect(g, x + w - 16, y + 5, 12, 20, "#e9eef0");
      rect(g, x + w - 16, y + 14, 12, 1, "#a6adb0");
    }
    if (fits(4, 4)) {
      const tx = x + w / 2 - 10,
        ty = y + h / 2 + 4;
      rect(g, tx, ty, 20, 14, "#9a643b");
      rect(g, tx + 1, ty + 1, 18, 11, "#b3774a");
    }
  } else if (/office|study|work|den/.test(name)) {
    rect(g, x + 6, y + 6, Math.min(40, w - 12), 12, "#7d5132");
    rect(g, x + 6, y + 6, Math.min(40, w - 12), 9, "#93633f");
    rect(g, x + 12, y + 5, 14, 7, "#232a33");
    rect(g, x + 13, y + 6, 12, 5, "#5fc7f0");
    rect(g, x + 15, y + 24, 9, 9, "#2f3238");
    if (fits(3, 4)) {
      rect(g, x + w - 12, y + h - 30, 8, 26, "#6b4529");
      for (let i = 0; i < 4; i++)
        rect(
          g,
          x + w - 11,
          y + h - 28 + i * 6,
          6,
          4,
          ["#c04a3c", "#3c74c0", "#d6b13c", "#4c9a58"][i],
        );
    }
  } else if (/bed|nursery|guest|kid/.test(name)) {
    const bx = x + 6,
      by = y + 8;
    rect(g, bx, by, 26, 38, "#6b4a2e");
    rect(g, bx + 2, by + 2, 22, 34, "#ecebf2");
    rect(g, bx + 4, by + 3, 18, 7, "#ffffff");
    rect(g, bx + 2, by + 14, 22, 22, "#577cb4");
    rect(g, bx + 30, by + 2, 10, 9, "#7b5534");
    if (fits(4, 4)) plant(g, x + w - 10, y + h - 12);
  } else if (/bath|toilet|wc|shower/.test(name)) {
    rect(g, x + 5, y + 6, 22, 34, "#dfe7ea");
    rect(g, x + 7, y + 8, 18, 30, "#a9d6e8");
    rect(g, x + w - 16, y + 7, 10, 12, "#eef3f4");
    rect(g, x + w - 14, y + 9, 6, 6, "#c7d4d8");
    rect(g, x + w - 15, y + h - 16, 9, 11, "#eef3f4");
  } else if (/garage|carport|workshop/.test(name)) {
    if (fits(4, 4)) {
      const cx = x + w / 2 - 14,
        cy = y + h / 2 - 20;
      rect(g, cx, cy, 28, 44, "#3b6ea8");
      rect(g, cx + 3, cy + 6, 22, 10, "#a9d6e8");
      rect(g, cx + 3, cy + 30, 22, 8, "#a9d6e8");
    }
    rect(g, x + 4, y + 6, 6, h - 12, "#6b4529");
    for (let i = 0; i < 3; i++)
      rect(g, x + 5, y + 10 + i * 12, 4, 5, "#c04a3c");
  } else if (
    /garden|patio|yard|outdoor|outside|balcony|terrace|porch|lawn/.test(name)
  ) {
    for (let i = 0; i < 6; i++) {
      const r = hash32(`${room.id}${i}`);
      const fx = x + 8 + (r % Math.max(1, w - 16)),
        fy = y + 8 + ((r >> 8) % Math.max(1, h - 16));
      rect(g, fx, fy, 3, 3, ["#f2d14c", "#e6697a", "#f5f1e8"][i % 3]);
      rect(g, fx + 1, fy + 3, 1, 2, "#3e7a37");
    }
    plant(g, x + 10, y + h - 12);
  } else if (/hall|entry|corridor|landing|stairs/.test(name)) {
    rect(g, x + w / 2 - 12, y + h - 12, 24, 8, "#7a5a3f");
    plant(g, x + w - 10, y + 12);
  } else {
    plant(g, x + 10, y + 12);
    if (fits(4, 4)) rect(g, x + w / 2 - 12, y + h / 2 - 8, 24, 16, "#b28a5c");
  }
}
function drawStatic(g, structure, night) {
  const rows = structure.grid.rows;
  const cols = structure.grid.cols || 16;
  g.imageSmoothingEnabled = false;
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < cols; tx++) {
      rect(g, tx * T, ty * T, T, T, (tx + ty) % 2 ? "#26352a" : "#2a3a2e");
      if (hash32(`o${tx},${ty}`) % 5 === 0)
        rect(g, tx * T + 5, ty * T + 9, 1, 2, "#355039");
    }
  for (const room of structure.rooms)
    for (let ty = room.y; ty < room.y + room.h; ty++)
      for (let tx = room.x; tx < room.x + room.w; tx++)
        floorTile(g, room.floor, tx, ty);
  for (const room of structure.rooms) furnish(g, room);
  for (const door of doorsOf(structure))
    if (door.vertical)
      rect(g, door.x * T - 1, door.y * T + 1, 3, T - 2, "#7a5838");
    else rect(g, door.x * T + 1, door.y * T - 1, T - 2, 3, "#7a5838");
  const H = rows * T;
  for (const wall of wallsOf(structure)) {
    const span = (wall.to - wall.from) * T;
    if (wall.vertical) {
      const x = clamp(wall.at * T - 2, 0, cols * T - 4);
      rect(g, x, wall.from * T - 2, 4, span + 4, "#3a2d28");
      rect(g, x + 1, wall.from * T - 1, 2, span + 2, "#ead9bd");
    } else {
      const y = clamp(wall.at * T - 2, 0, H - 5);
      rect(g, wall.from * T - 2, y + 4, span + 4, 2, "rgba(0,0,0,0.18)");
      rect(g, wall.from * T - 2, y, span + 4, 5, "#3a2d28");
      rect(g, wall.from * T - 1, y + 1, span + 2, 2, "#ead9bd");
    }
  }
  // Night follows sun.sun (or the clock): lights that are on stand out.
  if (night) rect(g, 0, 0, cols * T, H, "rgba(12,18,52,0.5)");
}
function glow(g, x, y, radius) {
  g.globalCompositeOperation = "lighter";
  const light = g.createRadialGradient(x, y, 1, x, y, radius);
  light.addColorStop(0, "rgba(255,214,120,0.55)");
  light.addColorStop(1, "rgba(255,214,120,0)");
  g.fillStyle = light;
  g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  g.globalCompositeOperation = "source-over";
}
function drawDevice(g, d) {
  const x = Math.round(d.x * T),
    y = Math.round(d.y * T);
  const dim = !d.observedAt || d.anomaly === "unavailable";
  g.globalAlpha = dim ? 0.55 : 1;
  rect(g, x - 5, y + 5, 10, 2, "rgba(0,0,0,0.22)");
  switch (d.kind) {
    case "light":
      if (d.active) glow(g, x, y - 6, 30);
      rect(g, x - 4, y + 3, 8, 3, "#3c3530");
      rect(g, x, y - 6, 1, 10, "#5c5048");
      rect(g, x - 5, y - 11, 11, 2, d.active ? "#ffe9a8" : "#b0a99c");
      rect(g, x - 4, y - 9, 9, 4, d.active ? "#ffd36b" : "#958e82");
      break;
    case "switch":
      if (d.active) glow(g, x, y, 14);
      rect(g, x - 4, y - 4, 8, 9, "#e9ecee");
      rect(g, x - 2, y - 2, 1, 3, "#3c4247");
      rect(g, x + 1, y - 2, 1, 3, "#3c4247");
      rect(g, x - 1, y + 2, 2, 1, d.active ? "#7dff9a" : "#7a8287");
      break;
    case "fan":
      rect(g, x - 1, y - 1, 3, 3, "#4d5357");
      rect(g, x - 7, y - 1, 6, 2, "#d9e1e3");
      rect(g, x + 2, y - 1, 6, 2, "#d9e1e3");
      rect(g, x - 1, y - 7, 2, 6, "#d9e1e3");
      rect(g, x - 1, y + 2, 2, 6, "#d9e1e3");
      if (d.active) rect(g, x + 6, y + 5, 2, 2, "#7dff9a");
      break;
    case "climate":
      rect(g, x - 8, y - 5, 16, 8, "#4d5357");
      rect(g, x - 7, y - 4, 14, 6, "#eef1f2");
      rect(g, x + 5, y - 3, 1, 1, d.active ? "#7dff9a" : "#b0b6b9");
      if (d.active)
        for (let i = 0; i < 3; i++)
          rect(
            g,
            x - 6 + i * 5,
            y + 5,
            2,
            1,
            /heat/.test(d.state) ? "#ffad6b" : "#a8e4ff",
          );
      break;
    case "thermo":
      rect(g, x - 2, y - 9, 4, 12, "#4d5357");
      rect(g, x - 1, y - 8, 2, 10, "#f4f6f6");
      rect(g, x - 1, y - 3, 2, 5, "#e0503c");
      rect(g, x - 3, y + 2, 6, 4, "#e0503c");
      break;
    case "humidity":
    case "leak":
      rect(g, x - 1, y - 8, 2, 2, "#5fb7e8");
      rect(g, x - 2, y - 6, 4, 3, "#5fb7e8");
      rect(g, x - 3, y - 3, 6, 5, "#5fb7e8");
      rect(g, x - 2, y + 2, 4, 1, "#3f8fc0");
      if (d.kind === "leak") rect(g, x - 6, y + 4, 12, 2, "#5fb7e8");
      break;
    case "door":
    case "garage":
      rect(g, x - 6, y - 7, 12, 13, "#6e4425");
      if (d.active) rect(g, x - 6, y - 7, 4, 13, "#2a1d14");
      else {
        rect(g, x - 5, y - 6, 10, 11, "#8d5b34");
        rect(g, x + 3, y - 1, 1, 2, "#f2c94c");
      }
      break;
    case "window":
      rect(g, x - 7, y - 5, 14, 9, "#ead9bd");
      rect(g, x - 6, y - 4, 12, 7, d.active ? "#1d2b38" : "#a9d6e8");
      rect(g, x, y - 4, 1, 7, "#ead9bd");
      if (d.active) rect(g, x - 9, y - 4, 3, 7, "#a9d6e8");
      break;
    case "motion":
      rect(g, x - 4, y - 4, 8, 8, "#eef3f4");
      rect(g, x - 2, y - 2, 4, 4, d.active ? "#e0503c" : "#5c6c72");
      break;
    case "lock":
      rect(g, x - 3, y - 7, 6, 2, "#9aa3a8");
      rect(g, x - 4, y - 5, 2, 4, "#9aa3a8");
      rect(
        g,
        x + 2,
        y - 5,
        2,
        4,
        d.state === "unlocked" ? "#00000000" : "#9aa3a8",
      );
      rect(g, x - 5, y - 2, 10, 8, "#d6b13c");
      rect(g, x - 1, y + 1, 2, 3, "#6b4a2e");
      break;
    case "vacuum":
      rect(g, x - 6, y - 4, 12, 9, "#2f3338");
      rect(g, x - 5, y - 5, 10, 11, "#2f3338");
      rect(g, x - 2, y - 2, 4, 4, d.active ? "#7dff9a" : "#5c6c72");
      break;
    case "printer":
      rect(g, x - 7, y - 10, 14, 15, "#2f3338");
      rect(g, x - 6, y - 9, 1, 13, "#c4c9cf");
      rect(g, x + 5, y - 9, 1, 13, "#c4c9cf");
      rect(g, x - 6, y - 9, 12, 1, "#c4c9cf");
      rect(g, x - 1, y - 7, 3, 3, "#e07a3a");
      if (/print|busy|running/.test(d.state))
        rect(g, x - 2, y - 1, 4, 2, "#f2c94c");
      break;
    case "media":
      rect(g, x - 8, y - 8, 16, 10, "#1f2329");
      rect(g, x - 7, y - 7, 14, 8, d.active ? "#7b6cf0" : "#2c333c");
      rect(g, x - 1, y + 2, 2, 3, "#1f2329");
      break;
    case "cover":
      rect(g, x - 7, y - 6, 14, 11, "#c9b391");
      for (let i = 0; i < 4; i++)
        rect(g, x - 7, y - 5 + i * 3, 14, 1, "#a68d68");
      break;
    case "battery":
      rect(g, x - 5, y - 3, 10, 7, "#eef3f4");
      rect(g, x + 5, y - 1, 1, 3, "#eef3f4");
      rect(
        g,
        x - 4,
        y - 2,
        d.anomaly === "low_battery" ? 2 : 7,
        5,
        d.anomaly ? "#e0503c" : "#7dc96a",
      );
      break;
    default:
      rect(g, x - 4, y - 4, 8, 8, "#d9e1e3");
      rect(g, x - 3, y - 3, 6, 6, "#eef3f4");
      rect(g, x - 1, y - 1, 2, 2, d.active ? "#7dff9a" : "#5fb7a0");
  }
  g.globalAlpha = 1;
  if (d.anomaly) {
    // A small, static glint: diamond with "!" (shape + colour + list text).
    rect(g, x + 4, y - 14, 7, 7, "#2b2118");
    rect(g, x + 5, y - 13, 5, 5, "#f2c94c");
    rect(g, x + 7, y - 12, 1, 2, "#2b2118");
    rect(g, x + 7, y - 9, 1, 1, "#2b2118");
  }
}
function drawHearth(g, walker, look, thinking) {
  const palette = PALETTES[look.palette] ?? PALETTES[0];
  const x = Math.round(walker.x * T),
    y = Math.round(walker.y * T);
  const step = walker.moving ? Math.round(Math.sin(walker.phase) * 1.5) : 0;
  rect(g, x - 5, y + 2, 10, 2, "rgba(0,0,0,0.28)");
  rect(g, x - 3, y - 2 + Math.max(0, step), 2, 4, "#352d3a");
  rect(g, x + 1, y - 2 + Math.max(0, -step), 2, 4, "#352d3a");
  rect(g, x - 4, y - 8, 8, 7, palette.body);
  rect(g, x - 4, y - 3, 8, 1, palette.trim);
  rect(g, x - 6, y - 8 + step, 2, 5, palette.body);
  rect(g, x + 4, y - 8 - step, 2, 5, palette.body);
  const hy = y - 15;
  rect(g, x - 4, hy, 8, 7, "#f1c7a0");
  rect(g, x - 4, hy - 1, 8, 3, palette.hair);
  if (walker.dir === "up") rect(g, x - 4, hy, 8, 6, palette.hair);
  else if (walker.dir === "left") {
    rect(g, x + 1, hy + 1, 3, 5, palette.hair);
    rect(g, x - 3, hy + 3, 1, 1, "#2a2230");
  } else if (walker.dir === "right") {
    rect(g, x - 4, hy + 1, 3, 5, palette.hair);
    rect(g, x + 2, hy + 3, 1, 1, "#2a2230");
  } else {
    rect(g, x - 2, hy + 3, 1, 1, "#2a2230");
    rect(g, x + 1, hy + 3, 1, 1, "#2a2230");
    rect(g, x - 3, hy + 5, 1, 1, "#f39d8a");
    rect(g, x + 2, hy + 5, 1, 1, "#f39d8a");
  }
  if (look.hat === "beanie") {
    rect(g, x - 5, hy - 3, 10, 3, palette.trim);
    rect(g, x - 5, hy - 1, 10, 1, palette.body);
    rect(g, x - 1, hy - 5, 2, 2, palette.trim);
  } else if (look.hat === "cap") {
    rect(g, x - 5, hy - 3, 10, 3, palette.body);
    if (walker.dir !== "up")
      rect(
        g,
        x + (walker.dir === "left" ? -8 : walker.dir === "right" ? 4 : -3),
        hy - 1,
        5,
        2,
        palette.trim,
      );
  } else if (look.hat === "bow") {
    rect(g, x + 2, hy - 3, 3, 3, "#e8576a");
    rect(g, x + 5, hy - 2, 2, 2, "#e8576a");
    rect(g, x, hy - 2, 2, 2, "#e8576a");
  } else if (look.hat === "crown") {
    rect(g, x - 4, hy - 3, 8, 2, "#f2c94c");
    for (const dx of [-4, -1, 2]) rect(g, x + dx, hy - 5, 2, 2, "#f2c94c");
  }
  if (thinking) {
    rect(g, x + 6, hy - 6, 2, 2, "#fffdf6");
    rect(g, x + 9, hy - 9, 3, 3, "#fffdf6");
  }
}
function drawPet(g, walker) {
  const x = Math.round(walker.x * T),
    y = Math.round(walker.y * T),
    flip = walker.dir === "left" ? -1 : 1;
  rect(g, x - 5, y + 1, 10, 2, "rgba(0,0,0,0.25)");
  rect(g, x - 4, y - 5, 9, 5, "#c48a4a");
  rect(g, x - 3, y - 1, 2, 2, "#9a6533");
  rect(g, x + 2, y - 1, 2, 2, "#9a6533");
  const hx = flip > 0 ? x + 3 : x - 7;
  rect(g, hx, y - 8, 5, 5, "#d39a58");
  rect(g, flip > 0 ? hx + 4 : hx, y - 6, 1, 1, "#2a2230");
  rect(g, flip > 0 ? hx : hx + 3, y - 9, 2, 3, "#9a6533");
  rect(g, flip > 0 ? x - 6 : x + 5, y - 6, 2, 2, "#c48a4a");
}

// ------------------------------------------------------------ the house
export function createHouse(ctx, { onClose }) {
  const motion = !reducedMotion();
  let view = "map",
    editing = false,
    editPanel = null,
    staticKey = "",
    drag = null,
    selectedRoom = "",
    announced = new Set();
  const canvas = el("canvas", {
    className: "wh-canvas",
    attrs: { "aria-hidden": "true" },
  });
  const g = canvas.getContext?.("2d");
  const background = document.createElement("canvas");
  const bg = background.getContext?.("2d");
  const layer = el("div", { className: "wh-layer" });
  const bubble = el("p", {
    className: "wh-bubble",
    attrs: { "aria-hidden": "true", hidden: "" },
  });
  const summary = el("p", { className: "sr-only" });
  const screen = el("div", { className: "wh-screen" }, [canvas, layer, bubble]);
  const frame = el("div", { className: "wh-frame" }, [screen]);
  const back = button("", "wh-back", "Back to chat");
  back.append(
    el("span", {
      className: "chevron",
      text: "‹",
      attrs: { "aria-hidden": "true" },
    }),
    el("span", { text: "Chat", attrs: { "aria-hidden": "true" } }),
  );
  back.addEventListener("click", () => onClose());
  const title = el("h2", { text: "Home World" });
  const listToggle = button("List", "wh-tool");
  listToggle.setAttribute("aria-pressed", "false");
  const editToggle = button("Edit", "wh-tool");
  editToggle.setAttribute("aria-pressed", "false");
  const head = el("header", { className: "app-view-head wh-head" }, [
    back,
    title,
    listToggle,
    editToggle,
  ]);
  const feedback = el("p", {
    className: "wh-feedback",
    attrs: { role: "status", "aria-live": "polite" },
  });
  const alerts = el("p", {
    className: "sr-only",
    attrs: { "aria-live": "polite" },
  });
  const bottom = el("div", { className: "wh-bottom" });
  const mapView = el("div", { className: "wh-map" }, [summary, frame, bottom]);
  const listHost = el("div", { className: "wh-list", attrs: { hidden: "" } });
  const element = el(
    "section",
    {
      className: "world-view",
      attrs: { "aria-labelledby": "world-title" },
    },
    [head, feedback, alerts, mapView, listHost],
  );
  title.id = "world-title";

  const layout = () =>
    ctx.structure ?? { rooms: [], devices: [], grid: { cols: 16, rows: 0 } };
  let devices = [];
  const actor = createThinkActor({
    motion,
    speed: 4,
    target: (d) => {
      const lay = layout();
      const stand = { x: d.x, y: clamp(d.y + 0.9, 0, lay.grid.rows - 0.4) };
      if (!roomAt(lay, stand.x, stand.y)) stand.y = d.y - 0.9;
      if (!roomAt(lay, stand.x, stand.y)) stand.x = d.x + 0.9;
      return stand;
    },
    path: (from, to) => planPath(layout(), from, to),
  });
  const loop = createRenderLoop(draw);
  const unwatch = watchVisibility(loop, canvas);

  function draw(dt) {
    const structure = ctx.structure;
    if (!g || !bg || !structure || !structure.rooms.length) return false;
    const moving = actor.step(dt);
    const W = (structure.grid.cols || 16) * T,
      H = structure.grid.rows * T;
    const night = !!ctx.values?.night;
    const key = JSON.stringify([structure.rooms, structure.grid, night]);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = background.width = W;
      canvas.height = background.height = H;
      staticKey = "";
    }
    if (key !== staticKey) {
      drawStatic(bg, structure, night);
      staticKey = key;
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(background, 0, 0);
    if (editing)
      for (const room of structure.rooms) {
        const on = room.id === selectedRoom;
        g.strokeStyle = on ? "#ffc58e" : "rgba(255,255,255,0.4)";
        g.lineWidth = on ? 2 : 1;
        g.setLineDash(on ? [] : [3, 3]);
        g.strokeRect(
          room.x * T + 2,
          room.y * T + 2,
          room.w * T - 4,
          room.h * T - 4,
        );
        if (on)
          rect(
            g,
            (room.x + room.w) * T - 8,
            (room.y + room.h) * T - 8,
            6,
            6,
            "#ffc58e",
          );
      }
    g.setLineDash([]);
    const look = structure.character;
    const sprites = devices.map((d) => ({
      y: d.y,
      draw: () => drawDevice(g, d),
    }));
    sprites.push({
      y: actor.hearth.y,
      draw: () => drawHearth(g, actor.hearth, look, ctx.think.busy),
    });
    if (structure.pet)
      sprites.push({ y: actor.pet.y, draw: () => drawPet(g, actor.pet) });
    sprites.sort((a, b) => a.y - b.y).forEach((s) => s.draw());
    const focus =
      ctx.think.entityId &&
      devices.find((d) => d.entityId === ctx.think.entityId);
    if (focus) {
      g.strokeStyle = "#ffc58e";
      g.lineWidth = 1;
      g.strokeRect(
        Math.round(focus.x * T - 12),
        Math.round(focus.y * T - 14),
        24,
        24,
      );
    }
    placeBubble();
    return moving;
  }
  function placeBubble() {
    const rows = layout().grid.rows || 1;
    const cols = layout().grid.cols || 16;
    const label = ctx.think.busy ? currentLabel() : "";
    bubble.hidden = !label || view !== "map";
    if (!label) return;
    bubble.textContent = label;
    bubble.style.left = `${(clamp(actor.hearth.x, 2.5, cols - 2.5) / cols) * 100}%`;
    bubble.style.top = `${(Math.max(actor.hearth.y - 1.2, 1.3) / rows) * 100}%`;
  }
  function currentLabel() {
    const device = devices.find((d) => d.entityId === ctx.think.entityId);
    return thinkLabel(
      ctx.think,
      device,
      device ? roomName(ctx.structure, device.room) : "",
    );
  }
  const pct = (v, total) => `${(v / Math.max(1, total)) * 100}%`;
  function renderLayer() {
    const structure = ctx.structure;
    const items = [];
    if (!structure) return layer.replaceChildren();
    const rows = structure.grid.rows;
    const cols = structure.grid.cols || 16;
    for (const level of structure.levels ?? []) {
      const label = el("span", { className: "wh-level", text: level.name });
      label.style.top = pct(level.y + 0.1, rows);
      items.push(label);
    }
    for (const room of structure.rooms) {
      const label = el("span", { className: "wh-room-label", text: room.name });
      label.style.left = pct(room.x + 0.15, cols);
      label.style.top = pct(room.y + 0.12, rows);
      label.style.maxWidth = pct(room.w - 0.3, cols);
      items.push(label);
    }
    for (const device of devices) {
      const target = button(
        "",
        "wh-device",
        `${device.name}: ${device.value}${device.anomaly ? `, ${ANOMALY_TEXT[device.anomaly]}` : ""}`,
      );
      target.dataset.entity = device.entityId;
      target.style.left = pct(device.x, cols);
      target.style.top = pct(device.y, rows);
      if (device.entityId === ctx.selected)
        target.setAttribute("aria-pressed", "true");
      if (device.anomaly) target.classList.add("wh-anomaly");
      if (
        [
          "thermo",
          "humidity",
          "sensor",
          "climate",
          "printer",
          "battery",
        ].includes(device.kind) &&
        device.observedAt
      )
        target.append(el("span", { className: "wh-tag", text: device.value }));
      items.push(target);
    }
    layer.replaceChildren(...items);
    screen.style.aspectRatio = `${cols} / ${Math.max(1, rows)}`;
    // Wide floor plans keep readable tiles and pan sideways on phones.
    screen.style.minWidth = cols > 16 ? `${cols * MIN_TILE_PX}px` : "";
  }
  function renderBottom() {
    if (editing) {
      if (!editPanel) {
        editPanel = createEditPanel(ctx, {
          onDone: () => setEditing(false),
          onSelectRoom: (id) => {
            selectedRoom = id;
            loop.invalidate();
          },
        });
        selectedRoom = editPanel.selectedRoom();
        bottom.replaceChildren(editPanel.element);
      } else editPanel.render();
      return;
    }
    editPanel = null;
    const device =
      ctx.selected && devices.find((d) => d.entityId === ctx.selected);
    if (device) {
      const key = bottom.contains(document.activeElement)
        ? document.activeElement.dataset?.key
        : "";
      bottom.replaceChildren(createDeviceCard(ctx, device));
      if (key) bottom.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
      return;
    }
    bottom.replaceChildren(dialogue());
  }
  function dialogue() {
    const box = el("div", { className: "wh-dialogue" });
    box.append(el("div", { className: "wh-nameplate", text: "Hearth" }));
    const body = el("div", { className: "wh-dialogue-body" });
    const structure = ctx.structure;
    if (!structure)
      body.append(
        el("p", { className: "wh-line wh-hint", text: "Building your home…" }),
      );
    else if (!structure.rooms.length)
      body.append(
        el("p", {
          className: "wh-line wh-hint",
          text: "Hearth can't read any devices yet. Add entities to allowed_entities in the App configuration; rooms come from their Home Assistant areas.",
        }),
      );
    else {
      if (structure.registry === "unavailable")
        body.append(
          el("p", {
            className: "wh-line wh-hint",
            text: "Couldn't read Home Assistant areas, so every device is in the Unassigned shed for now.",
          }),
        );
      const odd = devices.filter((d) => d.anomaly);
      if (ctx.think.busy)
        body.append(el("p", { className: "wh-status", text: currentLabel() }));
      for (const line of recentLines(ctx.snapshot, 2))
        body.append(
          el(
            "div",
            {
              className: `wh-line ${line.who === "You" ? "wh-you" : "wh-hearth"}`,
            },
            [
              el("span", { className: "wh-who", text: line.who }),
              el("span", { className: "wh-text", text: line.text }),
            ],
          ),
        );
      if (odd.length) {
        const list = el("div", { className: "wh-attention" });
        list.append(el("span", { className: "wh-who", text: "Needs a look" }));
        for (const d of odd) {
          const b = button(
            `⚠ ${d.name} · ${ANOMALY_TEXT[d.anomaly]}`,
            "wh-attention-item",
          );
          b.addEventListener("click", () => ctx.select(d.entityId));
          list.append(b);
        }
        body.append(list);
      }
      body.append(
        el("p", {
          className: "wh-line wh-hint",
          text: `${worldSummary(structure, devices)} Tap a device for details.`,
        }),
      );
    }
    box.append(body);
    return box;
  }
  function renderList() {
    listHost.replaceChildren(createListView(ctx));
  }
  function announce() {
    const fresh = devices.filter(
      (d) => d.anomaly && !announced.has(`${d.entityId}:${d.anomaly}`),
    );
    for (const d of fresh) announced.add(`${d.entityId}:${d.anomaly}`);
    if (fresh.length)
      alerts.textContent = fresh
        .map((d) => `${d.name}: ${ANOMALY_TEXT[d.anomaly]}`)
        .join(". ");
  }
  function render() {
    const structure = ctx.structure;
    devices = ctx.views();
    if (structure?.rooms.length) {
      const first = structure.rooms[0];
      actor.place({ x: first.x + first.w / 2, y: first.y + first.h / 2 });
    }
    if (actor.follow(ctx.think, devices)) loop.animate();
    summary.textContent = `Home World map. ${worldSummary(structure, devices)} The list view has the same devices and actions.`;
    feedback.textContent = ctx.notice;
    listToggle.textContent = view === "list" ? "Map" : "List";
    listToggle.setAttribute("aria-pressed", String(view === "list"));
    listToggle.setAttribute(
      "aria-label",
      view === "list" ? "Show map" : "Show list",
    );
    editToggle.setAttribute("aria-pressed", String(editing));
    editToggle.hidden = view === "list" || !structure?.rooms.length;
    mapView.hidden = view !== "map";
    listHost.hidden = view !== "list";
    element.classList.toggle("wh-editing", editing);
    announce();
    if (view === "list") {
      // Rebuild, then return focus to the same control for screen readers.
      const key = listHost.contains(document.activeElement)
        ? document.activeElement.dataset?.key
        : "";
      renderList();
      if (key)
        listHost.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    } else {
      renderLayer();
      renderBottom();
      loop.invalidate();
    }
  }
  function setEditing(next) {
    editing = next;
    if (editing) ctx.select(null);
    render();
  }
  listToggle.addEventListener("click", () => {
    view = view === "map" ? "list" : "map";
    if (view === "list") editing = false;
    render();
  });
  editToggle.addEventListener("click", () => setEditing(!editing));
  layer.addEventListener("click", (event) => {
    const target = event.target.closest?.(".wh-device");
    if (!target || editing || drag?.moved) return;
    ctx.select(
      ctx.selected === target.dataset.entity ? null : target.dataset.entity,
    );
  });
  // Edit mode: drag a room, its bottom-right corner, or a device; snap to tiles.
  const toGrid = (event) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * (layout().grid.cols || 16),
      y: ((event.clientY - box.top) / box.height) * layout().grid.rows,
    };
  };
  screen.addEventListener("pointerdown", (event) => {
    if (!editing) return;
    const point = toGrid(event);
    const deviceTarget = event.target.closest?.(".wh-device");
    if (deviceTarget)
      drag = {
        kind: "device",
        entityId: deviceTarget.dataset.entity,
        moved: false,
        node: deviceTarget,
      };
    else {
      const room = roomAt(layout(), point.x, point.y);
      if (!room) return;
      selectedRoom = room.id;
      editPanel?.selectRoom(room.id);
      const corner =
        Math.hypot(point.x - (room.x + room.w), point.y - (room.y + room.h)) <
        1.3;
      drag = {
        kind: corner ? "resize" : "room",
        id: room.id,
        start: point,
        origin: { ...room },
        moved: false,
      };
    }
    screen.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  screen.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = toGrid(event);
    drag.moved = true;
    if (drag.kind === "device") {
      drag.node.classList.add("wh-dragging");
      const cols = layout().grid.cols || 16;
      drag.node.style.left = pct(clamp(point.x, 0.3, cols - 0.3), cols);
      drag.node.style.top = pct(
        clamp(point.y, 0.3, layout().grid.rows - 0.3),
        layout().grid.rows,
      );
      drag.point = point;
      return;
    }
    const dx = Math.round(point.x - drag.start.x),
      dy = Math.round(point.y - drag.start.y);
    const o = drag.origin;
    const cols = layout().grid.cols || 16;
    const patch =
      drag.kind === "room"
        ? { x: clamp(o.x + dx, 0, cols - o.w), y: clamp(o.y + dy, 0, 64 - o.h) }
        : { w: clamp(o.w + dx, 2, cols - o.x), h: clamp(o.h + dy, 2, 16) };
    const room = layout().rooms.find((r) => r.id === drag.id);
    if (room && Object.entries(patch).some(([k, v]) => room[k] !== v))
      ctx.edit.room(drag.id, patch);
  });
  const endDrag = () => {
    if (drag?.kind === "device" && drag.point) {
      const place = placementFor(layout(), drag.point.x, drag.point.y);
      if (place) ctx.edit.device(drag.entityId, place);
      else render();
    }
    const moved = drag?.moved;
    setTimeout(() => (drag = null), 0);
    if (!moved) drag = null;
  };
  screen.addEventListener("pointerup", endDrag);
  screen.addEventListener("pointercancel", endDrag);
  const onKey = (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
      if (ctx.selected) ctx.select(null);
      else if (editing) setEditing(false);
      else onClose();
    }
  };
  document.addEventListener("keydown", onKey);
  const unsubscribe = ctx.subscribe(render);
  render();
  return {
    element,
    setEditing,
    destroy() {
      loop.stop();
      unwatch();
      unsubscribe();
      document.removeEventListener("keydown", onKey);
      element.remove();
    },
  };
}
