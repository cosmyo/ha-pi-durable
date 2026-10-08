/* PROTOTYPE — Home World variant A "Pixel house" (throwaway exploration).
 * A handheld-style split screen: a top-down pixel-art house drawn
 * procedurally on a 256×192 canvas (16×12 tiles of 16px, nearest-neighbour
 * upscaled) above an RPG dialogue box. All art is original and drawn in
 * code. Devices are transparent DOM buttons over the canvas (44px targets);
 * tapping one only opens a card whose button drafts a question.
 */
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
  doorsOf,
  placeDevices,
  placementFor,
  createActors,
  createEditPanel,
} from "./prototype-world.js";

const T = 16;
const W = GRID.cols * T,
  H = GRID.rows * T;

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
      const shade = (r >> row) & 1 ? "#b9794a" : "#c3844f";
      rect(g, x, y + row * 4, T, 4, shade);
      rect(g, x, y + row * 4 + 3, T, 1, "#95592f");
      const seam = (tx * 7 + (ty * 4 + row) * 5) % 16;
      rect(g, x + seam, y + row * 4, 1, 3, "#9c6136");
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
    for (let i = 0; i < 4; i++)
      rect(
        g,
        x + ((r >> (i * 4)) & 15),
        y + ((r >> (i * 4 + 2)) & 15),
        1,
        1,
        "#acaca5",
      );
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
function furnish(g, room) {
  const x = room.x * T,
    y = room.y * T,
    w = room.w * T,
    h = room.h * T,
    name = room.name.toLowerCase();
  const fits = (tw, th) => room.w >= tw && room.h >= th;
  if (/living|lounge/.test(name)) {
    if (fits(5, 4)) {
      const rx = x + w / 2 - 28,
        ry = y + h / 2 - 14;
      rect(g, rx, ry, 56, 30, "#a8834f");
      rect(g, rx + 2, ry + 2, 52, 26, "#d1b07a");
      for (let i = 0; i < 4; i++)
        rect(g, rx + 6, ry + 6 + i * 5, 44, 1, "#bf9a63");
      rect(g, x + w / 2 - 16, y + 14, 32, 6, "#2a2f36");
      rect(g, x + w / 2 - 14, y + 15, 28, 4, "#3f5466");
    }
    const sx = x + w / 2 - 22,
      sy = y + h - 22;
    rect(g, sx, sy, 44, 14, "#5d3a55");
    rect(g, sx + 2, sy + 2, 40, 8, "#7c4d70");
    rect(g, sx + 3, sy + 10, 38, 4, "#6c4262");
    plant(g, x + 10, y + 10);
  } else if (/kitchen/.test(name)) {
    rect(g, x + 3, y + 3, w - 6, 13, "#9b9486");
    rect(g, x + 3, y + 3, w - 6, 10, "#ddd6c7");
    for (let i = 3; i < w - 6; i += 16) rect(g, x + i, y + 3, 1, 10, "#c8c0b0");
    rect(g, x + 18, y + 4, 14, 8, "#31353b");
    for (const [dx, dy] of [
      [2, 1],
      [8, 1],
      [2, 5],
      [8, 5],
    ])
      rect(g, x + 18 + dx, y + 4 + dy, 3, 2, "#575d66");
    if (fits(4, 3)) {
      rect(g, x + w - 16, y + 3, 12, 20, "#e9eef0");
      rect(g, x + w - 16, y + 12, 12, 1, "#a6adb0");
      rect(g, x + w - 6, y + 6, 1, 4, "#a6adb0");
    }
    if (fits(4, 4)) {
      const tx = x + w / 2 - 10,
        ty = y + h / 2 + 2;
      rect(g, tx, ty, 20, 14, "#9a643b");
      rect(g, tx + 1, ty + 1, 18, 11, "#b3774a");
      rect(g, tx - 6, ty + 4, 5, 6, "#7b4a2a");
      rect(g, tx + 21, ty + 4, 5, 6, "#7b4a2a");
    }
  } else if (/office|study/.test(name)) {
    rect(g, x + 6, y + 4, Math.min(40, w - 12), 12, "#7d5132");
    rect(g, x + 6, y + 4, Math.min(40, w - 12), 9, "#93633f");
    rect(g, x + 12, y + 3, 14, 7, "#232a33");
    rect(g, x + 13, y + 4, 12, 5, "#5fc7f0");
    rect(g, x + 15, y + 22, 9, 9, "#2f3238");
    rect(g, x + 16, y + 23, 7, 7, "#43464e");
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
  } else if (/bed/.test(name)) {
    const bx = x + 6,
      by = y + 6;
    rect(g, bx, by, 26, 38, "#6b4a2e");
    rect(g, bx + 2, by + 2, 22, 34, "#ecebf2");
    rect(g, bx + 4, by + 3, 18, 7, "#ffffff");
    rect(g, bx + 2, by + 14, 22, 22, "#577cb4");
    rect(g, bx + 2, by + 14, 22, 2, "#6d93cc");
    rect(g, bx + 30, by + 2, 10, 9, "#7b5534");
    if (fits(4, 4)) plant(g, x + w - 10, y + h - 12);
  } else if (/hall|entry/.test(name)) {
    rect(g, x + w / 2 - 12, y + h - 12, 24, 8, "#7a5a3f");
    for (let i = 0; i < 6; i++)
      rect(g, x + w / 2 - 10 + i * 4, y + h - 11, 2, 6, "#946f50");
    plant(g, x + w - 10, y + 10);
    rect(g, x + 4, y + 8, 6, 20, "#6b4529");
  } else if (/patio|garden|outdoor|balcony/.test(name)) {
    for (let i = 0; i < 6; i++) {
      const r = hash32(`${room.id}${i}`);
      const fx = x + 8 + (r % Math.max(1, w - 16)),
        fy = y + 8 + ((r >> 8) % Math.max(1, h - 16));
      rect(g, fx, fy, 3, 3, ["#f2d14c", "#e6697a", "#f5f1e8"][i % 3]);
      rect(g, fx + 1, fy + 3, 1, 2, "#3e7a37");
    }
    if (fits(4, 3)) {
      rect(g, x + w / 2 - 14, y + h / 2, 28, 6, "#8d5b34");
      rect(g, x + w / 2 - 14, y + h / 2 + 2, 28, 1, "#6e4425");
    }
    plant(g, x + 10, y + h - 12);
  } else {
    plant(g, x + 10, y + 10);
    if (fits(3, 3)) rect(g, x + w / 2 - 12, y + h / 2 - 8, 24, 16, "#b28a5c");
  }
}
function drawStatic(g, layout) {
  g.imageSmoothingEnabled = false;
  for (let ty = 0; ty < GRID.rows; ty++)
    for (let tx = 0; tx < GRID.cols; tx++) {
      rect(g, tx * T, ty * T, T, T, (tx + ty) % 2 ? "#26352a" : "#2a3a2e");
      if (hash32(`o${tx},${ty}`) % 5 === 0)
        rect(g, tx * T + 5, ty * T + 9, 1, 2, "#355039");
    }
  for (const room of layout.rooms)
    for (let ty = room.y; ty < room.y + room.h; ty++)
      for (let tx = room.x; tx < room.x + room.w; tx++)
        floorTile(g, room.floor, tx, ty);
  for (const room of layout.rooms) furnish(g, room);
  for (const door of doorsOf(layout))
    if (door.vertical)
      rect(g, door.x * T - 1, door.y * T + 1, 3, T - 2, "#7a5838");
    else rect(g, door.x * T + 1, door.y * T - 1, T - 2, 3, "#7a5838");
  for (const wall of wallsOf(layout)) {
    if (wall.vertical) {
      const x = clamp(wall.at * T - 2, 0, W - 4);
      rect(
        g,
        x,
        wall.from * T - 2,
        4,
        (wall.to - wall.from) * T + 4,
        "#3a2d28",
      );
      rect(
        g,
        x + 1,
        wall.from * T - 1,
        2,
        (wall.to - wall.from) * T + 2,
        "#ead9bd",
      );
    } else {
      const y = clamp(wall.at * T - 2, 0, H - 5);
      rect(
        g,
        wall.from * T - 2,
        y + 4,
        (wall.to - wall.from) * T + 4,
        2,
        "rgba(0,0,0,0.18)",
      );
      rect(
        g,
        wall.from * T - 2,
        y,
        (wall.to - wall.from) * T + 4,
        5,
        "#3a2d28",
      );
      rect(
        g,
        wall.from * T - 1,
        y + 1,
        (wall.to - wall.from) * T + 2,
        2,
        "#ead9bd",
      );
      rect(
        g,
        wall.from * T - 1,
        y + 3,
        (wall.to - wall.from) * T + 2,
        1,
        "#c9b391",
      );
    }
  }
}
function drawDevice(g, d, time, motion) {
  const x = Math.round(d.x * T),
    y = Math.round(d.y * T);
  const unavailable = /unavailable|unknown/.test(d.state);
  g.globalAlpha = unavailable ? 0.55 : 1;
  rect(g, x - 5, y + 5, 10, 2, "rgba(0,0,0,0.22)");
  if (d.kind === "light" || d.kind === "switch" || d.kind === "fan") {
    if (d.active) {
      g.globalCompositeOperation = "lighter";
      const glow = g.createRadialGradient(x, y - 6, 1, x, y - 6, 30);
      glow.addColorStop(0, "rgba(255,214,120,0.55)");
      glow.addColorStop(1, "rgba(255,214,120,0)");
      g.fillStyle = glow;
      g.fillRect(x - 30, y - 36, 60, 60);
      g.globalCompositeOperation = "source-over";
    }
    if (d.kind === "switch") {
      rect(g, x - 4, y - 4, 8, 9, "#e9ecee");
      rect(g, x - 2, y - 2, 1, 3, "#3c4247");
      rect(g, x + 1, y - 2, 1, 3, "#3c4247");
      rect(g, x - 1, y + 2, 2, 1, d.active ? "#7dff9a" : "#7a8287");
    } else {
      rect(g, x - 4, y + 3, 8, 3, "#3c3530");
      rect(g, x, y - 6, 1, 10, "#5c5048");
      rect(g, x - 5, y - 11, 11, 2, d.active ? "#ffe9a8" : "#b0a99c");
      rect(g, x - 4, y - 9, 9, 4, d.active ? "#ffd36b" : "#958e82");
    }
  } else if (d.kind === "climate") {
    rect(g, x - 8, y - 5, 16, 8, "#4d5357");
    rect(g, x - 7, y - 4, 14, 6, "#eef1f2");
    rect(g, x - 6, y, 12, 1, "#a8b0b4");
    rect(g, x + 5, y - 3, 1, 1, d.active ? "#7dff9a" : "#b0b6b9");
    if (d.active) {
      const heat = /heat/.test(d.state);
      const shift = motion ? Math.floor(time * 6) % 4 : 0;
      for (let i = 0; i < 3; i++)
        rect(
          g,
          x - 6 + i * 5,
          y + 4 + ((shift + i) % 4),
          2,
          1,
          heat ? "#ffad6b" : "#a8e4ff",
        );
    }
  } else if (d.kind === "thermo") {
    rect(g, x - 2, y - 9, 4, 12, "#4d5357");
    rect(g, x - 1, y - 8, 2, 10, "#f4f6f6");
    rect(g, x - 1, y - 3, 2, 5, "#e0503c");
    rect(g, x - 3, y + 2, 6, 4, "#e0503c");
  } else if (d.kind === "printer") {
    rect(g, x - 7, y - 10, 14, 15, "#2f3338");
    rect(g, x - 6, y - 9, 1, 13, "#c4c9cf");
    rect(g, x + 5, y - 9, 1, 13, "#c4c9cf");
    rect(g, x - 6, y - 9, 12, 1, "#c4c9cf");
    rect(g, x - 5, y + 1, 10, 2, "#1d2125");
    const printing = /print|busy|running/.test(d.state);
    const nx =
      printing && motion ? x - 3 + Math.round(Math.sin(time * 3) * 3) : x - 1;
    rect(g, nx, y - 7, 3, 3, "#e07a3a");
    if (printing) rect(g, x - 2, y - 1, 4, 2, "#f2c94c");
    rect(
      g,
      x - 6,
      y + 5,
      2,
      1,
      unavailable ? "#e05a4a" : printing ? "#ffb347" : "#7dff9a",
    );
  } else if (d.kind === "media") {
    rect(g, x - 8, y - 8, 16, 10, "#1f2329");
    rect(g, x - 7, y - 7, 14, 8, d.active ? "#7b6cf0" : "#2c333c");
    rect(g, x - 1, y + 2, 2, 3, "#1f2329");
  } else {
    rect(g, x - 4, y - 4, 8, 8, "#d9e1e3");
    rect(g, x - 3, y - 3, 6, 6, "#eef3f4");
    rect(g, x - 1, y - 1, 2, 2, d.active ? "#7dff9a" : "#5fb7a0");
  }
  g.globalAlpha = 1;
}
function drawHearth(g, walker, look, time, thinking) {
  const palette = PALETTES[look.palette] ?? PALETTES[0];
  const x = Math.round(walker.x * T),
    y = Math.round(walker.y * T);
  const step = walker.moving ? Math.round(Math.sin(walker.phase) * 1.5) : 0;
  const bob = !walker.moving && thinking ? Math.round(Math.sin(time * 4)) : 0;
  rect(g, x - 5, y + 2, 10, 2, "rgba(0,0,0,0.28)");
  rect(g, x - 3, y - 2 + Math.max(0, step), 2, 4, "#352d3a");
  rect(g, x + 1, y - 2 + Math.max(0, -step), 2, 4, "#352d3a");
  rect(g, x - 4, y - 8 + bob, 8, 7, palette.body);
  rect(g, x - 4, y - 3 + bob, 8, 1, palette.trim);
  rect(g, x - 6, y - 8 + bob + step, 2, 5, palette.body);
  rect(g, x + 4, y - 8 + bob - step, 2, 5, palette.body);
  rect(g, x - 6, y - 4 + bob + step, 2, 1, "#f1c7a0");
  rect(g, x + 4, y - 4 + bob - step, 2, 1, "#f1c7a0");
  const hy = y - 15 + bob;
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
    const brim = walker.dir === "left" ? -8 : walker.dir === "right" ? 4 : -3;
    if (walker.dir !== "up")
      rect(
        g,
        x + brim,
        hy - 1,
        5 + (walker.dir === "down" ? 1 : 0),
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
    rect(g, x - 1, hy - 3, 2, 1, "#e0503c");
  }
}
function drawPet(g, walker, time) {
  const x = Math.round(walker.x * T),
    y = Math.round(walker.y * T),
    flip = walker.dir === "left" ? -1 : 1;
  const tail =
    Math.round(Math.sin(time * 10)) *
    (walker.moving || !reducedMotion() ? 1 : 0);
  rect(g, x - 5, y + 1, 10, 2, "rgba(0,0,0,0.25)");
  rect(g, x - 4, y - 5, 9, 5, "#c48a4a");
  rect(g, x - 3, y - 1, 2, 2, "#9a6533");
  rect(g, x + 2, y - 1, 2, 2, "#9a6533");
  const hx = flip > 0 ? x + 3 : x - 7;
  rect(g, hx, y - 8, 5, 5, "#d39a58");
  rect(g, flip > 0 ? hx + 4 : hx, y - 6, 1, 1, "#2a2230");
  rect(g, flip > 0 ? hx : hx + 3, y - 9, 2, 3, "#9a6533");
  const tx = flip > 0 ? x - 6 : x + 5;
  rect(g, tx, y - 6 + tail, 2, 2, "#c48a4a");
}

// ------------------------------------------------------------ the variant
export function createVariant(ctx) {
  const { overlay, store } = ctx;
  let world = null,
    devices = [],
    selected = null,
    editing = false,
    editPanel = null,
    staticDirty = true,
    raf = 0,
    last = performance.now(),
    visible = true,
    drag = null;
  const motion = !reducedMotion();
  const canvas = el("canvas", {
    className: "px-canvas",
    attrs: { width: W, height: H, "aria-hidden": "true" },
  });
  const g = canvas.getContext("2d");
  const background = document.createElement("canvas");
  background.width = W;
  background.height = H;
  const bg = background.getContext("2d");
  const layer = el("div", { className: "px-layer" });
  const bubble = el("p", {
    className: "px-bubble",
    attrs: { "aria-hidden": "true" },
  });
  const screen = el("div", { className: "px-screen" }, [canvas, layer, bubble]);
  const title = el("span", { className: "px-title", text: "Home World" });
  const editButton = button("Edit home", "px-edit-toggle");
  editButton.setAttribute("aria-pressed", "false");
  const top = el("div", { className: "px-top" }, [
    screen,
    el("div", { className: "px-toolbar" }, [title, editButton]),
  ]);
  const nameplate = el("div", { className: "px-nameplate", text: "Hearth" });
  const card = el("div", { className: "px-card", attrs: { hidden: "" } });
  const lines = el("div", {
    className: "px-lines",
    attrs: {
      role: "log",
      "aria-label": "Latest conversation",
      "aria-live": "polite",
    },
  });
  const status = el("p", { className: "px-status", attrs: { role: "status" } });
  const dialogue = el("div", { className: "px-dialogue" }, [
    nameplate,
    el("div", { className: "px-dialogue-body" }, [card, lines, status]),
  ]);
  const bottom = el("div", { className: "px-bottom" }, [dialogue]);
  const root = el("div", { className: "px-shell" }, [top, bottom]);
  overlay.append(root);
  const actors = createActors(store.get());

  function renderCard() {
    card.replaceChildren();
    card.hidden = !selected;
    if (!selected) return;
    const device = devices.find((d) => d.entityId === selected);
    if (!device) {
      selected = null;
      card.hidden = true;
      return;
    }
    const ask = button("Ask Hearth about this", "px-ask");
    ask.disabled = !world?.canDraft;
    ask.addEventListener("click", () => ctx.ask(device));
    const close = button("✕", "px-card-close", "Close device card");
    close.addEventListener("click", () => {
      selected = null;
      renderCard();
      renderLayer();
    });
    card.append(
      el("div", { className: "px-card-head" }, [
        el("strong", { text: device.name }),
        close,
      ]),
      el("p", { className: "px-card-value", text: device.value }),
      el("p", {
        className: "px-card-meta",
        text: `${device.entityId} · HA read ${device.observedAt ? new Date(device.observedAt).toLocaleTimeString() : "?"} · saved observation`,
      }),
      ask,
    );
  }
  function renderDialogue() {
    const items = [];
    if (!world?.canvas)
      items.push(
        el("p", {
          className: "px-line px-hint",
          text:
            world?.home === false
              ? "Home World only shows Home conversations."
              : "Hearth hasn't seen your home yet. This is a starter house.",
        }),
      );
    for (const line of world?.lines.slice(-4) ?? [])
      items.push(
        el(
          "div",
          {
            className: `px-line ${line.who === "You" ? "px-you" : "px-hearth"}`,
          },
          [
            el("span", { className: "px-who", text: line.who }),
            el("span", { className: "px-text", text: line.text }),
          ],
        ),
      );
    if (!world?.canvas && world?.home !== false) {
      const build = button("Build me a home view", "px-ask");
      build.disabled = !world?.canDraft;
      build.addEventListener("click", () => ctx.build());
      items.push(build);
    } else if (!world?.lines.length)
      items.push(
        el("p", {
          className: "px-line px-hint",
          text: "Tap a device to ask Hearth about it.",
        }),
      );
    lines.replaceChildren(...items);
    lines.scrollTop = lines.scrollHeight;
    status.textContent = world?.busy ? world.status : "";
    status.hidden = !world?.busy;
    title.textContent = world?.canvas?.title ?? "Starter home";
  }
  function pct(value, total) {
    return `${(value / total) * 100}%`;
  }
  function renderLayer() {
    const layout = store.get();
    const items = [];
    if (editing)
      for (const room of layout.rooms) {
        const label = el("span", {
          className: "px-room-label",
          text: room.name,
        });
        label.style.left = pct(room.x + 0.15, GRID.cols);
        label.style.top = pct(room.y + 0.15, GRID.rows);
        items.push(label);
      }
    for (const device of devices) {
      const target = button("", "px-device", `${device.name}: ${device.value}`);
      target.dataset.entity = device.entityId;
      target.style.left = pct(device.x, GRID.cols);
      target.style.top = pct(device.y, GRID.rows);
      if (device.entityId === selected)
        target.setAttribute("aria-pressed", "true");
      if (device.entityId === world?.focus?.entityId)
        target.classList.add("px-focus");
      if (
        ["thermo", "sensor", "climate", "printer", "binary"].includes(
          device.kind,
        ) ||
        editing
      ) {
        target.append(
          el("span", {
            className: "px-tag",
            text: editing ? device.name : device.value,
          }),
        );
      }
      items.push(target);
    }
    layer.replaceChildren(...items);
  }
  function setEditing(next) {
    editing = next;
    editButton.setAttribute("aria-pressed", String(editing));
    editButton.textContent = editing ? "Editing…" : "Edit home";
    root.classList.toggle("px-editing", editing);
    if (editing) {
      editPanel = createEditPanel(
        { ...ctx, onRoomSelected: () => (staticDirty = true) },
        { onDone: () => setEditing(false), title: "Edit home · touch screen" },
      );
      editPanel.setDevices(world?.devices ?? []);
      bottom.replaceChildren(editPanel.element);
    } else {
      editPanel?.destroy();
      editPanel = null;
      bottom.replaceChildren(dialogue);
    }
    staticDirty = true;
    renderLayer();
  }
  editButton.addEventListener("click", () => setEditing(!editing));

  // Pointer: tap device → card; in edit mode drag devices / rooms on a grid.
  const toGrid = (event) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * GRID.cols,
      y: ((event.clientY - box.top) / box.height) * GRID.rows,
    };
  };
  layer.addEventListener("click", (event) => {
    const target = event.target.closest?.(".px-device");
    if (!target || editing || drag?.moved) return;
    selected =
      selected === target.dataset.entity ? null : target.dataset.entity;
    renderCard();
    renderLayer();
  });
  screen.addEventListener("pointerdown", (event) => {
    if (!editing) return;
    const point = toGrid(event);
    const deviceTarget = event.target.closest?.(".px-device");
    const layout = store.get();
    if (deviceTarget)
      drag = {
        kind: "device",
        entityId: deviceTarget.dataset.entity,
        moved: false,
      };
    else {
      const room = roomAt(layout, point.x, point.y);
      if (!room) return;
      editPanel?.selectRoom(room.id);
      const corner =
        Math.hypot(point.x - (room.x + room.w), point.y - (room.y + room.h)) <
        1.2;
      drag = {
        kind: corner ? "resize" : "room",
        id: room.id,
        start: point,
        origin: { ...room },
        moved: false,
      };
    }
    screen.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  screen.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = toGrid(event);
    drag.moved = true;
    if (drag.kind === "device") {
      const button = layer.querySelector(
        `[data-entity="${CSS.escape(drag.entityId)}"]`,
      );
      if (button) {
        button.classList.add("px-dragging");
        button.style.left = pct(
          clamp(point.x, 0.3, GRID.cols - 0.3),
          GRID.cols,
        );
        button.style.top = pct(clamp(point.y, 0.3, GRID.rows - 0.3), GRID.rows);
      }
      drag.point = point;
      return;
    }
    const dx = Math.round(point.x - drag.start.x),
      dy = Math.round(point.y - drag.start.y);
    store.update((layout) => {
      const room = layout.rooms.find((r) => r.id === drag.id);
      if (!room) return;
      if (drag.kind === "room") {
        room.x = clamp(drag.origin.x + dx, 0, GRID.cols - room.w);
        room.y = clamp(drag.origin.y + dy, 0, GRID.rows - room.h);
      } else {
        room.w = clamp(drag.origin.w + dx, 2, GRID.cols - room.x);
        room.h = clamp(drag.origin.h + dy, 2, GRID.rows - room.y);
      }
    });
  });
  const endDrag = () => {
    if (drag?.kind === "device" && drag.point) {
      const place = placementFor(store.get(), drag.point.x, drag.point.y);
      if (place)
        store.update((layout) => (layout.devices[drag.entityId] = place));
      else renderLayer();
    }
    setTimeout(() => (drag = null), 0);
  };
  screen.addEventListener("pointerup", endDrag);
  screen.addEventListener("pointercancel", endDrag);

  const unsubscribe = store.subscribe(() => {
    staticDirty = true;
    devices = placeDevices(store.get(), world?.devices ?? []);
    renderLayer();
  });
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const layout = store.get();
    if (staticDirty) {
      drawStatic(bg, layout);
      staticDirty = false;
    }
    actors.tick(dt, world ?? { busy: false }, layout, devices);
    const time = now / 1000;
    g.imageSmoothingEnabled = false;
    g.drawImage(background, 0, 0);
    if (editing) {
      const selectedRoom = editPanel?.selectedRoom();
      for (const room of layout.rooms) {
        g.strokeStyle =
          room.id === selectedRoom ? "#ffc58e" : "rgba(255,255,255,0.35)";
        g.lineWidth = room.id === selectedRoom ? 2 : 1;
        g.setLineDash(room.id === selectedRoom ? [] : [3, 3]);
        g.strokeRect(
          room.x * T + 2,
          room.y * T + 2,
          room.w * T - 4,
          room.h * T - 4,
        );
        if (room.id === selectedRoom)
          rect(
            g,
            (room.x + room.w) * T - 7,
            (room.y + room.h) * T - 7,
            5,
            5,
            "#ffc58e",
          );
      }
      g.setLineDash([]);
    }
    const sprites = [
      ...devices.map((d) => ({
        y: d.y,
        draw: () => drawDevice(g, d, time, motion),
      })),
      {
        y: actors.hearth.y,
        draw: () =>
          drawHearth(g, actors.hearth, layout.character, time, !!world?.busy),
      },
    ];
    if (layout.pet)
      sprites.push({
        y: actors.pet.y,
        draw: () => drawPet(g, actors.pet, time),
      });
    sprites.sort((a, b) => a.y - b.y).forEach((s) => s.draw());
    const focus =
      world?.focus?.entityId &&
      devices.find((d) => d.entityId === world.focus.entityId);
    if (focus) {
      const r = motion ? 11 + Math.sin(time * 5) * 2 : 12;
      g.strokeStyle = "#ffc58e";
      g.lineWidth = 1;
      g.strokeRect(
        Math.round(focus.x * T - r),
        Math.round(focus.y * T - r),
        Math.round(r * 2),
        Math.round(r * 2),
      );
    }
    if (world?.busy) {
      bubble.hidden = false;
      bubble.textContent = world.focus?.label ?? (motion ? "…" : "Thinking…");
      bubble.style.left = pct(
        clamp(actors.hearth.x, 2.5, GRID.cols - 2.5),
        GRID.cols,
      );
      bubble.style.top = pct(Math.max(actors.hearth.y - 1.3, 1.4), GRID.rows);
    } else bubble.hidden = true;
    schedule();
  }
  function schedule() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const onVisibility = () => {
    last = performance.now();
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    onVisibility();
  });
  observer.observe(canvas);
  schedule();

  return {
    update(next) {
      world = next;
      devices = placeDevices(store.get(), world.devices);
      editPanel?.setDevices(world.devices);
      renderDialogue();
      renderCard();
      renderLayer();
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      editPanel?.destroy();
      root.remove();
    },
  };
}
