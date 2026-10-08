/* Home World v1 — ambient think-mode strip (the everyday surface).
 * Chat stays primary. A small chip above the conversation summarizes the
 * home; it drops into a side-view "cut-away" strip of the house while Hearth
 * is thinking, or when pulled down / tapped. The avatar walks to the room of
 * the device a running tool call names. Original art drawn in code.
 */
import {
  ANOMALY_TEXT,
  PALETTES,
  attentionView,
  button,
  clamp,
  createDeviceCard,
  createRenderLoop,
  createThinkActor,
  el,
  hash32,
  reducedMotion,
  roomName,
  spawnRoom,
  thinkLabel,
  watchVisibility,
} from "./world.js";

const U = 24; // CSS px per tile along the strip
const WALLS = {
  wood: ["#f0dfc2", "#e5d0ac"],
  tile: ["#dcebe6", "#c9ddd6"],
  carpet: ["#d9d3ea", "#c7c0dd"],
  stone: ["#d7d6cf", "#c4c3bb"],
  grass: ["#9fd0ea", "#c4e5f2"],
};
const FLOOR = {
  wood: ["#b9794a", "#95592f"],
  tile: ["#efe6d2", "#cdbf9f"],
  carpet: ["#6d7dab", "#8292c2"],
  stone: ["#9a9a93", "#83837c"],
  grass: ["#5e9c4a", "#4f8a40"],
};
const LINGER_MS = 2500;

export function createStrip(ctx) {
  const motion = !reducedMotion();
  let pinned = false,
    linger = false,
    lingerTimer = 0,
    wasBusy = false,
    rooms = [],
    devices = [],
    span = 0,
    scroll = 0,
    wasOpen = false;
  const chip = button("", "amb-chip");
  chip.setAttribute("aria-expanded", "false");
  const chipDot = el("span", {
    className: "amb-dot",
    attrs: { "aria-hidden": "true" },
  });
  const chipText = el("span", { className: "amb-chip-text" });
  chip.append(
    chipDot,
    chipText,
    el("span", {
      className: "amb-chip-caret",
      text: "▾",
      attrs: { "aria-hidden": "true" },
    }),
  );
  const statusText = el("span", {
    className: "amb-status",
    attrs: { role: "status" },
  });
  const open = button("⤢", "amb-icon", "Open Home World");
  const collapse = button("▴", "amb-icon", "Collapse Home World strip");
  const canvas = el("canvas", {
    className: "amb-canvas",
    attrs: { "aria-hidden": "true" },
  });
  const g = canvas.getContext?.("2d");
  const tags = el("div", { className: "amb-tags" });
  const bubble = el("p", {
    className: "amb-bubble",
    attrs: { "aria-hidden": "true", hidden: "" },
  });
  const view = el("div", { className: "amb-view" }, [canvas, tags, bubble]);
  const card = el("div", { className: "amb-card", attrs: { hidden: "" } });
  const strip = el("div", { className: "amb-strip" }, [
    el("div", { className: "amb-head" }, [statusText, open, collapse]),
    view,
    card,
  ]);
  const element = el(
    "section",
    { className: "amb", attrs: { "aria-label": "Home World" } },
    [chip, strip],
  );
  const actor = createThinkActor({
    motion,
    speed: 110,
    target: (d) => ({ x: d.sx + (d.sx > actor.hearth.x ? -20 : 20), y: 0 }),
    path: (_from, to) => [to],
  });
  const loop = createRenderLoop(draw);
  watchVisibility(loop, view);

  const isOpen = () => pinned || ctx.think.busy || linger;
  // Rooms in reading order (row by row) become a left-to-right side view.
  function layoutStrip() {
    const structure = ctx.structure;
    rooms = [];
    let x = 0;
    for (const room of [...(structure?.rooms ?? [])].sort(
      (a, b) => a.y - b.y || a.x - b.x,
    )) {
      rooms.push({ ...room, left: x, width: Math.max(4, room.w) * U });
      x += Math.max(4, room.w) * U + 6;
    }
    span = Math.max(0, x - 6);
    devices = ctx.views().flatMap((d) => {
      const room = rooms.find((r) => r.id === d.room);
      if (!room) return [];
      return [{ ...d, sx: room.left + clamp(d.fx, 0.1, 0.9) * room.width }];
    });
  }
  function summaryText() {
    const structure = ctx.structure;
    if (!structure) return "Home World";
    // The strip chip's count reflects the same filtered "Needs a look" list
    // as the full house view, not every raw anomaly flag.
    const odd = attentionView(devices).total;
    if (!structure.rooms.length) return "Home World · no devices in scope";
    return `Home · ${structure.rooms.length} room${structure.rooms.length === 1 ? "" : "s"} · ${devices.length} device${devices.length === 1 ? "" : "s"}${odd ? ` · ⚠ ${odd}` : ""}`;
  }
  function label() {
    const device = devices.find((d) => d.entityId === ctx.think.entityId);
    return thinkLabel(
      ctx.think,
      device,
      device ? roomName(ctx.structure, device.room) : "",
    );
  }
  function render() {
    layoutStrip();
    const busy = ctx.think.busy;
    if (wasBusy && !busy) {
      linger = true;
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(
        () => {
          linger = false;
          render();
        },
        motion ? LINGER_MS : 1000,
      );
    }
    wasBusy = busy;
    const opened = isOpen();
    if (opened !== wasOpen) {
      wasOpen = opened;
      ctx.setStripOpen(opened);
    }
    element.classList.toggle("amb-open", opened);
    chip.hidden = opened;
    chip.setAttribute("aria-expanded", String(opened));
    chipText.textContent = busy ? label() : summaryText();
    chipDot.classList.toggle("amb-thinking", busy);
    statusText.textContent = busy
      ? label()
      : linger
        ? "Done."
        : ctx.notice || summaryText();
    if (opened && rooms.length) {
      // Same room as the full house view: a lived-in room, never decor or
      // the shed, never the strip's own leading (first) slot by accident.
      const spawn = spawnRoom(ctx.structure);
      const home = (spawn && rooms.find((r) => r.id === spawn.id)) || rooms[0];
      actor.place({ x: home.left + Math.min(48, home.width / 2), y: 0 });
      if (actor.follow(ctx.think, devices)) loop.animate();
    }
    renderTags();
    renderCard();
    if (opened) loop.invalidate();
  }
  function renderTags() {
    const items = [];
    for (const d of devices) {
      const target = button(
        "",
        "amb-device",
        `${d.name}: ${d.value}${d.anomaly ? `, ${ANOMALY_TEXT[d.anomaly]}` : ""}`,
      );
      target.dataset.entity = d.entityId;
      target.style.left = `${d.sx - scroll}px`;
      if (d.entityId === ctx.think.entityId) target.classList.add("amb-focus");
      if (d.anomaly) target.classList.add("amb-anomaly");
      if (
        [
          "thermo",
          "humidity",
          "sensor",
          "climate",
          "printer",
          "battery",
        ].includes(d.kind) &&
        d.observedAt
      )
        target.append(el("span", { className: "amb-tag", text: d.value }));
      items.push(target);
    }
    for (const room of rooms) {
      const name = el("span", { className: "amb-room", text: room.name });
      name.dataset.room = room.id;
      name.style.left = `${room.left - scroll + 4}px`;
      items.push(name);
    }
    tags.replaceChildren(...items);
  }
  function renderCard() {
    const d = ctx.selected && devices.find((x) => x.entityId === ctx.selected);
    card.hidden = !d || !isOpen();
    if (card.hidden) return card.replaceChildren();
    const key = card.contains(document.activeElement)
      ? document.activeElement.dataset?.key
      : "";
    card.replaceChildren(createDeviceCard(ctx, d, { open: true }));
    if (key) card.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  // --------------------------------------------------------------- drawing
  function rect(x, y, w, h, color) {
    g.fillStyle = color;
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function drawRoom(room, h) {
    const x = room.left - scroll,
      w = room.width,
      floorY = h - 14;
    const [wall, wall2] = WALLS[room.floor] ?? WALLS.wood;
    rect(x, 0, w, floorY, wall);
    if (room.floor === "grass") {
      for (let i = 0; i < 3; i++)
        rect(
          x + 10 + (hash32(room.id + i) % Math.max(1, w - 30)),
          10 + i * 9,
          16,
          4,
          "#f4fbff",
        );
      for (let i = 0; i < w; i += 8) rect(x + i, floorY - 14, 2, 14, "#c8a77a");
      rect(x, floorY - 10, w, 2, "#c8a77a");
    } else {
      for (let i = 0; i < w; i += 12) rect(x + i, 0, 6, floorY, wall2);
      rect(x, floorY - 6, w, 6, "#cdb48c");
    }
    const [floor, floor2] = FLOOR[room.floor] ?? FLOOR.wood;
    rect(x, floorY, w, 14, floor);
    for (let i = 0; i < w; i += 8)
      rect(x + i, floorY + (i % 16 ? 4 : 9), 6, 1, floor2);
    if (room.floor !== "grass") rect(x, 0, w, 4, "#3a2d28");
    const name = `${room.name} ${room.area ?? ""}`.toLowerCase();
    const cx = x + w / 2;
    if (room.id === "unassigned") {
      for (let i = 0; i < 3; i++)
        rect(x + 8 + i * 22, floorY - 18, 18, 18, "#a87b4f");
    } else if (/living|lounge|family|tv/.test(name)) {
      rect(cx - 30, floorY - 18, 60, 12, "#7c4d70");
      rect(cx - 32, floorY - 26, 10, 20, "#6c4262");
      rect(cx + 22, floorY - 26, 10, 20, "#6c4262");
    } else if (/kitchen|dining/.test(name)) {
      rect(x + 6, floorY - 26, w - 12, 26, "#9b9486");
      rect(x + 6, floorY - 28, w - 12, 4, "#ddd6c7");
      rect(x + 6, 14, w - 12, 18, "#c9b58f");
      rect(x + w - 26, floorY - 52, 18, 52, "#e9eef0");
    } else if (/office|study|work|den/.test(name)) {
      rect(x + 8, floorY - 24, 44, 4, "#93633f");
      rect(x + 10, floorY - 20, 4, 20, "#7d5132");
      rect(x + 46, floorY - 20, 4, 20, "#7d5132");
      rect(x + 20, floorY - 40, 22, 14, "#232a33");
      rect(x + 22, floorY - 38, 18, 10, "#5fc7f0");
    } else if (/bed|nursery|guest|kid/.test(name)) {
      rect(x + 8, floorY - 16, 70, 10, "#ecebf2");
      rect(x + 8, floorY - 12, 50, 6, "#577cb4");
      rect(x + 6, floorY - 30, 6, 30, "#6b4a2e");
      rect(x + 76, floorY - 20, 6, 20, "#6b4a2e");
    } else if (/bath|toilet|wc|shower/.test(name)) {
      rect(x + 8, floorY - 16, 54, 16, "#eef3f4");
      rect(x + 10, floorY - 14, 50, 6, "#a9d6e8");
      rect(x + w - 24, floorY - 44, 14, 18, "#cfe3ea");
    } else if (/garage|carport|workshop/.test(name)) {
      rect(cx - 34, floorY - 22, 68, 16, "#3b6ea8");
      rect(cx - 22, floorY - 34, 40, 14, "#3b6ea8");
      rect(cx - 18, floorY - 31, 32, 9, "#a9d6e8");
      rect(cx - 26, floorY - 8, 12, 8, "#1f2329");
      rect(cx + 14, floorY - 8, 12, 8, "#1f2329");
    } else if (/hall|entry|corridor|landing|stairs/.test(name)) {
      rect(cx - 10, floorY - 46, 20, 46, "#7a5a3f");
      rect(cx + 5, floorY - 24, 2, 2, "#f2c94c");
    }
    if (room.floor === "grass")
      for (let i = 0; i < 4; i++) {
        const bx = x + 12 + (hash32(`${room.id}b${i}`) % Math.max(1, w - 24));
        rect(bx - 8, floorY - 12, 16, 12, i % 2 ? "#4f9b4b" : "#3f8441");
      }
  }
  function drawDevice(d, h) {
    const x = Math.round(d.sx - scroll),
      floorY = h - 14;
    g.globalAlpha = !d.observedAt || d.anomaly === "unavailable" ? 0.55 : 1;
    switch (d.kind) {
      case "light": {
        rect(x, 4, 1, 22, "#3a2d28");
        if (d.active) {
          const beam = g.createLinearGradient(0, 30, 0, floorY);
          beam.addColorStop(0, "rgba(255,214,120,0.55)");
          beam.addColorStop(1, "rgba(255,214,120,0)");
          g.fillStyle = beam;
          g.beginPath();
          g.moveTo(x - 6, 32);
          g.lineTo(x + 7, 32);
          g.lineTo(x + 26, floorY);
          g.lineTo(x - 25, floorY);
          g.fill();
        }
        rect(x - 7, 26, 15, 6, d.active ? "#ffd36b" : "#958e82");
        rect(x - 2, 32, 5, 3, d.active ? "#fff2c2" : "#6f6a62");
        break;
      }
      case "fan":
        rect(x, 4, 2, 12, "#3a2d28");
        rect(x - 16, 16, 34, 3, "#d9e1e3");
        rect(x - 3, 15, 8, 5, "#4d5357");
        break;
      case "switch":
        rect(x - 4, floorY - 30, 9, 12, "#e9ecee");
        rect(x - 1, floorY - 27, 3, 4, d.active ? "#7dff9a" : "#7a8287");
        break;
      case "climate":
        rect(x - 16, 12, 32, 12, "#eef1f2");
        rect(x - 16, 22, 32, 2, "#a8b0b4");
        rect(x + 11, 15, 2, 2, d.active ? "#7dff9a" : "#b0b6b9");
        break;
      case "thermo":
        rect(x - 3, floorY - 46, 6, 18, "#4d5357");
        rect(x - 2, floorY - 45, 4, 16, "#f4f6f6");
        rect(x - 2, floorY - 38, 4, 9, "#e0503c");
        break;
      case "humidity":
      case "leak":
        rect(x - 2, floorY - 46, 4, 4, "#5fb7e8");
        rect(x - 4, floorY - 42, 8, 8, "#5fb7e8");
        if (d.kind === "leak") rect(x - 12, floorY - 2, 24, 2, "#5fb7e8");
        break;
      case "door":
      case "garage":
        rect(x - 12, floorY - 50, 24, 50, "#6e4425");
        if (d.active) rect(x - 12, floorY - 50, 8, 50, "#2a1d14");
        else rect(x + 6, floorY - 26, 3, 3, "#f2c94c");
        break;
      case "window":
        rect(x - 14, 16, 28, 26, "#ead9bd");
        rect(x - 12, 18, 24, 22, d.active ? "#1d2b38" : "#a9d6e8");
        rect(x - 1, 18, 2, 22, "#ead9bd");
        break;
      case "motion":
        rect(x - 5, 8, 10, 8, "#eef3f4");
        rect(x - 2, 11, 4, 3, d.active ? "#e0503c" : "#5c6c72");
        break;
      case "lock":
        rect(x - 6, floorY - 34, 12, 10, "#d6b13c");
        rect(x - 4, floorY - 40, 2, 6, "#9aa3a8");
        rect(x + 2, floorY - 40, 2, d.state === "unlocked" ? 2 : 6, "#9aa3a8");
        break;
      case "vacuum":
        rect(x - 10, floorY - 6, 20, 6, "#2f3338");
        rect(x - 2, floorY - 5, 4, 2, d.active ? "#7dff9a" : "#5c6c72");
        break;
      case "printer":
        rect(x - 14, floorY - 18, 28, 4, "#7d5132");
        rect(x - 12, floorY - 14, 3, 14, "#7d5132");
        rect(x + 9, floorY - 14, 3, 14, "#7d5132");
        rect(x - 11, floorY - 40, 22, 22, "#2f3338");
        rect(x - 9, floorY - 38, 18, 2, "#c4c9cf");
        rect(x - 2, floorY - 34, 5, 5, "#e07a3a");
        break;
      case "media":
        rect(x - 18, floorY - 44, 36, 22, "#1f2329");
        rect(x - 16, floorY - 42, 32, 18, d.active ? "#7b6cf0" : "#2c333c");
        break;
      case "cover":
        rect(x - 14, 14, 28, 30, "#c9b391");
        for (let i = 0; i < 6; i++) rect(x - 14, 16 + i * 5, 28, 1, "#a68d68");
        break;
      default:
        rect(x - 5, floorY - 40, 10, 10, "#dfe6e8");
        rect(x - 1, floorY - 36, 3, 3, d.active ? "#7dff9a" : "#5fb7a0");
    }
    g.globalAlpha = 1;
    if (d.anomaly) {
      rect(x + 6, 4, 9, 9, "#2b2118");
      rect(x + 7, 5, 7, 7, "#f2c94c");
      rect(x + 10, 6, 1, 3, "#2b2118");
      rect(x + 10, 10, 1, 1, "#2b2118");
    }
    if (d.entityId === ctx.think.entityId || d.entityId === ctx.selected) {
      g.strokeStyle = "#ffc58e";
      g.lineWidth = 2;
      g.strokeRect(x - 18, floorY - 52, 36, 48);
    }
  }
  function drawHearth(h) {
    const look = ctx.structure.character;
    const p = PALETTES[look.palette] ?? PALETTES[0];
    const walker = actor.hearth;
    const x = Math.round(walker.x - scroll),
      floorY = h - 14,
      face = walker.dir === "left" ? -1 : 1;
    const step = walker.moving
      ? Math.round(Math.sin(walker.phase * 1.4) * 3)
      : 0;
    rect(x - 8, floorY - 1, 16, 3, "rgba(0,0,0,0.2)");
    rect(x - 4 + step, floorY - 10, 4, 10, "#352d3a");
    rect(x - step, floorY - 10, 4, 10, "#352d3a");
    rect(x - 7, floorY - 26, 14, 16, p.body);
    rect(x - 7, floorY - 14, 14, 2, p.trim);
    rect(x - 2 + step * face, floorY - 24, 4, 11, p.body);
    const hy = floorY - 40;
    rect(x - 7, hy, 14, 14, "#f1c7a0");
    rect(x - 7, hy - 2, 14, 5, p.hair);
    rect(face > 0 ? x - 7 : x + 3, hy, 4, 10, p.hair);
    rect(x + face * 3, hy + 6, 2, 2, "#2a2230");
    if (look.hat === "beanie") {
      rect(x - 8, hy - 6, 16, 6, p.trim);
      rect(x - 2, hy - 9, 4, 3, p.trim);
    } else if (look.hat === "cap") {
      rect(x - 8, hy - 5, 16, 5, p.body);
      rect(face > 0 ? x + 6 : x - 14, hy - 2, 8, 2, p.trim);
    } else if (look.hat === "bow") rect(x - 2, hy - 6, 10, 5, "#e8576a");
    else if (look.hat === "crown") {
      rect(x - 7, hy - 5, 14, 4, "#f2c94c");
      for (const dx of [-7, -2, 3]) rect(x + dx, hy - 8, 4, 3, "#f2c94c");
    }
  }
  function drawPet(h) {
    const walker = actor.pet;
    const x = Math.round(walker.x - scroll),
      floorY = h - 14,
      face = walker.dir === "left" ? -1 : 1;
    rect(x - 9, floorY - 1, 18, 3, "rgba(0,0,0,0.2)");
    rect(x - 9, floorY - 12, 18, 8, "#c48a4a");
    rect(x - 7, floorY - 4, 3, 4, "#9a6533");
    rect(x + 4, floorY - 4, 3, 4, "#9a6533");
    rect(face > 0 ? x + 6 : x - 14, floorY - 18, 9, 9, "#d39a58");
    rect(face > 0 ? x + 6 : x - 9, floorY - 20, 3, 5, "#9a6533");
    rect(face > 0 ? x - 13 : x + 9, floorY - 16, 4, 3, "#c48a4a");
  }
  function draw(dt) {
    if (!g || !isOpen() || !ctx.structure || !rooms.length) return false;
    const moving = actor.step(dt);
    const width = view.clientWidth,
      height = view.clientHeight,
      dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (!width || !height) return moving;
    if (
      canvas.width !== Math.round(width * dpr) ||
      canvas.height !== Math.round(height * dpr)
    ) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    scroll =
      span <= width
        ? -(width - span) / 2
        : clamp(actor.hearth.x - width / 2, 0, span - width);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    rect(0, 0, width, height, "#1b2725");
    for (const room of rooms) drawRoom(room, height);
    for (let i = 1; i < rooms.length; i++) {
      const x = rooms[i].left - scroll - 6;
      rect(x, 0, 6, height - 14, "#3a2d28");
      rect(x + 1, height - 52, 4, 38, "#7a5838");
    }
    if (ctx.values?.night) rect(0, 0, width, height, "rgba(12,18,52,0.45)");
    for (const d of devices) drawDevice(d, height);
    if (ctx.structure.pet) drawPet(height);
    drawHearth(height);
    for (const node of tags.children) {
      if (node.dataset.entity) {
        const d = devices.find((x) => x.entityId === node.dataset.entity);
        if (d) node.style.left = `${d.sx - scroll}px`;
      } else if (node.dataset.room) {
        const room = rooms.find((r) => r.id === node.dataset.room);
        if (room) node.style.left = `${room.left - scroll + 4}px`;
      }
    }
    const text = ctx.think.busy ? label() : "";
    bubble.hidden = !text;
    if (text) {
      bubble.textContent = text;
      // Keep the whole bubble inside the strip (it is centred on its left).
      const half = Math.min(bubble.offsetWidth || 160, width) / 2;
      bubble.style.left = `${clamp(actor.hearth.x - scroll, half + 4, Math.max(half + 4, width - half - 4))}px`;
    }
    return moving;
  }

  // ---------------------------------------------------------------- input
  let pull = null;
  chip.addEventListener("pointerdown", (event) => {
    pull = { y: event.clientY };
  });
  chip.addEventListener("pointermove", (event) => {
    if (pull && event.clientY - pull.y > 24) {
      pull = null;
      setPinned(true);
    }
  });
  chip.addEventListener("click", () => setPinned(true));
  collapse.addEventListener("click", () => {
    linger = false;
    clearTimeout(lingerTimer);
    if (ctx.selected) ctx.select(null);
    setPinned(false);
  });
  open.addEventListener("click", () => ctx.openFull({}));
  let swipe = null;
  view.addEventListener("pointerdown", (event) => {
    swipe = { y: event.clientY };
  });
  view.addEventListener("pointermove", (event) => {
    if (swipe && swipe.y - event.clientY > 30) {
      swipe = null;
      linger = false;
      setPinned(false);
    }
  });
  view.addEventListener("pointerup", () => (swipe = null));
  tags.addEventListener("click", (event) => {
    const target = event.target.closest?.(".amb-device");
    if (!target) return;
    ctx.select(
      ctx.selected === target.dataset.entity ? null : target.dataset.entity,
    );
  });
  function setPinned(next) {
    pinned = next;
    render();
  }
  ctx.subscribe(render);
  render();
  return { element };
}
