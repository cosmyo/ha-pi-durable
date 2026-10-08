/* PROTOTYPE — Home World variant C "Ambient think mode" (throwaway).
 * Chat stays primary. A side-view "cut-away" strip of the house (rooms in a
 * row, like a dollhouse seen from the front) drops down above the chat only
 * while Hearth is thinking, or when the owner pulls it down; otherwise it
 * collapses to a small status chip. The character walks sideways to the
 * device being read, with a thought bubble. Original art drawn in code.
 */
import {
  PALETTES,
  el,
  button,
  clamp,
  hash32,
  reducedMotion,
  placeDevices,
  createEditPanel,
  Walker,
} from "./prototype-world.js";

const U = 24; // CSS px per grid tile along the strip
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

export function createVariant(ctx) {
  const { inline, store } = ctx;
  const motion = !reducedMotion();
  let world = null,
    devices = [],
    pinned = false,
    linger = 0,
    editing = false,
    editPanel = null,
    selected = null,
    rooms = [],
    span = 0,
    scroll = 0,
    wasBusy = false;
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
  const collapse = button("▴", "amb-icon", "Collapse home strip");
  const editButton = button("Edit", "amb-icon amb-edit-toggle", "Edit home");
  editButton.setAttribute("aria-pressed", "false");
  const canvas = el("canvas", {
    className: "amb-canvas",
    attrs: { "aria-hidden": "true" },
  });
  const g = canvas.getContext("2d");
  const tags = el("div", { className: "amb-tags" });
  const bubble = el("p", {
    className: "amb-bubble",
    attrs: { "aria-hidden": "true" },
  });
  const view = el("div", { className: "amb-view" }, [canvas, tags, bubble]);
  const card = el("div", { className: "amb-card", attrs: { hidden: "" } });
  const strip = el("div", { className: "amb-strip" }, [
    el("div", { className: "amb-head" }, [
      el("span", { className: "world-proto-tag", text: "Prototype" }),
      statusText,
      editButton,
      collapse,
    ]),
    view,
    card,
  ]);
  const editHost = el("div", { className: "amb-edit" });
  const root = el(
    "section",
    {
      className: "amb",
      attrs: { "aria-label": "Home World ambient strip (prototype)" },
    },
    [chip, strip, editHost],
  );
  inline.append(root);

  const hearth = new Walker(U * 2, 0, motion ? 70 : 1e6);
  const pet = new Walker(U, 0, 80);
  let wanderTimer = 2,
    targetKey = "";

  // Rooms in reading order (row by row) become a left-to-right side view.
  function layoutStrip() {
    const layout = store.get();
    rooms = [];
    let x = 0;
    for (const room of [...layout.rooms].sort(
      (a, b) => a.y - b.y || a.x - b.x,
    )) {
      rooms.push({ ...room, left: x, width: room.w * U });
      x += room.w * U + 6;
    }
    span = Math.max(0, x - 6);
    devices = placeDevices(layout, world?.devices ?? []).map((d) => {
      const room = rooms.find((r) => r.id === d.room) ?? rooms[0];
      return {
        ...d,
        sx: room.left + clamp((d.x - room.x) / room.w, 0.08, 0.92) * room.width,
      };
    });
  }
  function open() {
    return editing || pinned || !!world?.busy || linger > 0;
  }
  function renderChrome() {
    const isOpen = open();
    root.classList.toggle("amb-open", isOpen);
    root.classList.toggle("amb-editing", editing);
    chip.setAttribute("aria-expanded", String(isOpen));
    chip.hidden = isOpen;
    const on = devices.filter((d) => d.active).length;
    chipText.textContent = world?.busy
      ? world.status
      : world?.canvas
        ? `${world.canvas.title} · ${devices.length} devices · ${on} on`
        : "Home World · pull down to peek";
    chipDot.classList.toggle("amb-thinking", !!world?.busy);
    statusText.textContent = world?.busy
      ? world.status
      : editing
        ? "Drag devices along the strip"
        : linger > 0
          ? "Done — tucking the house away…"
          : world?.canvas
            ? world.canvas.title
            : "Starter home";
    editButton.setAttribute("aria-pressed", String(editing));
  }
  function renderCard() {
    card.replaceChildren();
    const d = selected && devices.find((x) => x.entityId === selected);
    const noCanvas = !world?.canvas && world?.home !== false;
    card.hidden = !d && !noCanvas;
    if (d) {
      const ask = button("Ask Hearth about this", "amb-ask");
      ask.disabled = !world?.canDraft;
      ask.addEventListener("click", () => ctx.ask(d));
      const close = button("✕", "amb-icon", "Close device card");
      close.addEventListener("click", () => {
        selected = null;
        renderCard();
      });
      card.append(el("strong", { text: `${d.name} · ${d.value}` }), ask, close);
    } else if (noCanvas) {
      const build = button("Build me a home view", "amb-ask");
      build.disabled = !world?.canDraft;
      build.addEventListener("click", () => ctx.build());
      card.append(
        el("span", { text: "Starter home — Hearth hasn't seen yours yet." }),
        build,
      );
    }
  }
  function renderTags() {
    const items = [];
    for (const d of devices) {
      const target = button("", "amb-device", `${d.name}: ${d.value}`);
      target.dataset.entity = d.entityId;
      target.style.left = `${d.sx - scroll}px`;
      if (d.entityId === world?.focus?.entityId)
        target.classList.add("amb-focus");
      if (
        ["thermo", "sensor", "climate", "printer", "binary"].includes(d.kind) ||
        editing
      )
        target.append(
          el("span", {
            className: "amb-tag",
            text: editing ? d.name : d.value,
          }),
        );
      items.push(target);
    }
    if (editing)
      for (const room of rooms) {
        const label = el("span", { className: "amb-room", text: room.name });
        label.style.left = `${room.left - scroll + 4}px`;
        items.push(label);
      }
    tags.replaceChildren(...items);
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
          x + 10 + (hash32(room.id + i) % Math.max(1, w - 30) | 0),
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
    const name = room.name.toLowerCase();
    const cx = x + w / 2;
    if (/living|lounge/.test(name)) {
      rect(cx - 30, floorY - 18, 60, 12, "#7c4d70");
      rect(cx - 32, floorY - 26, 10, 20, "#6c4262");
      rect(cx + 22, floorY - 26, 10, 20, "#6c4262");
      rect(cx - 24, floorY - 6, 4, 6, "#4a2f22");
      rect(cx + 20, floorY - 6, 4, 6, "#4a2f22");
    } else if (/kitchen/.test(name)) {
      rect(x + 6, floorY - 26, w - 12, 26, "#9b9486");
      rect(x + 6, floorY - 28, w - 12, 4, "#ddd6c7");
      rect(x + 6, 14, w - 12, 18, "#c9b58f");
      for (let i = x + 10; i < x + w - 16; i += 18)
        rect(i, 18, 12, 10, "#ddc9a0");
      rect(x + w - 26, floorY - 52, 18, 52, "#e9eef0");
    } else if (/office|study/.test(name)) {
      rect(x + 8, floorY - 24, 44, 4, "#93633f");
      rect(x + 10, floorY - 20, 4, 20, "#7d5132");
      rect(x + 46, floorY - 20, 4, 20, "#7d5132");
      rect(x + 20, floorY - 40, 22, 14, "#232a33");
      rect(x + 22, floorY - 38, 18, 10, "#5fc7f0");
      rect(x + 56, floorY - 20, 12, 4, "#2f3238");
      rect(x + 60, floorY - 16, 3, 16, "#2f3238");
    } else if (/bed/.test(name)) {
      rect(x + 8, floorY - 16, 70, 10, "#ecebf2");
      rect(x + 8, floorY - 12, 50, 6, "#577cb4");
      rect(x + 6, floorY - 30, 6, 30, "#6b4a2e");
      rect(x + 76, floorY - 20, 6, 20, "#6b4a2e");
    } else if (/hall|entry/.test(name)) {
      rect(cx - 10, floorY - 46, 20, 46, "#7a5a3f");
      rect(cx + 5, floorY - 24, 2, 2, "#f2c94c");
    }
    if (room.floor === "grass") {
      for (let i = 0; i < 4; i++) {
        const bx = x + 12 + (hash32(`${room.id}b${i}`) % Math.max(1, w - 24));
        rect(bx - 8, floorY - 12, 16, 12, i % 2 ? "#4f9b4b" : "#3f8441");
      }
    }
  }
  function drawDevice(d, h, time) {
    const x = Math.round(d.sx - scroll),
      floorY = h - 14,
      dim = /unavailable|unknown/.test(d.state);
    g.globalAlpha = dim ? 0.55 : 1;
    if (d.kind === "light" || d.kind === "fan") {
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
    } else if (d.kind === "switch") {
      rect(x - 4, floorY - 30, 9, 12, "#e9ecee");
      rect(x - 1, floorY - 27, 3, 4, d.active ? "#7dff9a" : "#7a8287");
    } else if (d.kind === "climate") {
      rect(x - 16, 12, 32, 12, "#eef1f2");
      rect(x - 16, 22, 32, 2, "#a8b0b4");
      rect(x + 11, 15, 2, 2, d.active ? "#7dff9a" : "#b0b6b9");
      if (d.active) {
        const heat = /heat/.test(d.state);
        const shift = motion ? Math.floor(time * 6) % 6 : 0;
        for (let i = 0; i < 4; i++)
          rect(
            x - 12 + i * 8,
            28 + ((shift + i * 2) % 6),
            4,
            2,
            heat ? "#ffad6b" : "#8fd8ff",
          );
      }
    } else if (d.kind === "thermo") {
      rect(x - 3, floorY - 46, 6, 18, "#4d5357");
      rect(x - 2, floorY - 45, 4, 16, "#f4f6f6");
      rect(x - 2, floorY - 38, 4, 9, "#e0503c");
    } else if (d.kind === "printer") {
      rect(x - 14, floorY - 18, 28, 4, "#7d5132");
      rect(x - 12, floorY - 14, 3, 14, "#7d5132");
      rect(x + 9, floorY - 14, 3, 14, "#7d5132");
      rect(x - 11, floorY - 40, 22, 22, "#2f3338");
      rect(x - 9, floorY - 38, 18, 2, "#c4c9cf");
      const printing = /print|busy|running/.test(d.state);
      const nx =
        printing && motion ? x - 2 + Math.round(Math.sin(time * 3) * 5) : x - 2;
      rect(nx, floorY - 34, 5, 5, "#e07a3a");
      rect(
        x - 9,
        floorY - 22,
        3,
        2,
        dim ? "#e05a4a" : printing ? "#ffb347" : "#7dff9a",
      );
    } else if (d.kind === "media") {
      rect(x - 18, floorY - 44, 36, 22, "#1f2329");
      rect(x - 16, floorY - 42, 32, 18, d.active ? "#7b6cf0" : "#2c333c");
    } else {
      rect(x - 5, floorY - 40, 10, 10, "#dfe6e8");
      rect(x - 1, floorY - 36, 3, 3, d.active ? "#7dff9a" : "#5fb7a0");
    }
    g.globalAlpha = 1;
    if (d.entityId === world?.focus?.entityId || d.entityId === selected) {
      g.strokeStyle = "#ffc58e";
      g.lineWidth = 2;
      const r = motion ? 18 + Math.sin(time * 5) * 2 : 18;
      g.strokeRect(
        x - r,
        floorY - 52 + (d.kind === "light" || d.kind === "climate" ? -24 : 0),
        r * 2,
        48,
      );
    }
  }
  function drawHearth(h, time) {
    const look = store.get().character;
    const p = PALETTES[look.palette] ?? PALETTES[0];
    const x = Math.round(hearth.x - scroll),
      floorY = h - 14,
      face = hearth.dir === "left" ? -1 : 1;
    const step = hearth.moving
      ? Math.round(Math.sin(hearth.phase * 1.4) * 3)
      : 0;
    const bob =
      !hearth.moving && world?.busy && motion
        ? Math.round(Math.abs(Math.sin(time * 4)) * 2)
        : 0;
    rect(x - 8, floorY - 1, 16, 3, "rgba(0,0,0,0.2)");
    rect(x - 4 + step, floorY - 10, 4, 10, "#352d3a");
    rect(x - step, floorY - 10, 4, 10, "#352d3a");
    rect(x - 7, floorY - 26 - bob, 14, 16, p.body);
    rect(x - 7, floorY - 14 - bob, 14, 2, p.trim);
    rect(x - 2 + step * face, floorY - 24 - bob, 4, 11, p.body);
    const hy = floorY - 40 - bob;
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
    } else if (look.hat === "bow") {
      rect(x - 2, hy - 6, 10, 5, "#e8576a");
    } else if (look.hat === "crown") {
      rect(x - 7, hy - 5, 14, 4, "#f2c94c");
      for (const dx of [-7, -2, 3]) rect(x + dx, hy - 8, 4, 3, "#f2c94c");
    }
  }
  function drawPet(h, time) {
    const x = Math.round(pet.x - scroll),
      floorY = h - 14,
      face = pet.dir === "left" ? -1 : 1;
    rect(x - 9, floorY - 1, 18, 3, "rgba(0,0,0,0.2)");
    rect(x - 9, floorY - 12, 18, 8, "#c48a4a");
    rect(x - 7, floorY - 4, 3, 4, "#9a6533");
    rect(x + 4, floorY - 4, 3, 4, "#9a6533");
    rect(face > 0 ? x + 6 : x - 14, floorY - 18, 9, 9, "#d39a58");
    rect(face > 0 ? x + 6 : x - 9, floorY - 20, 3, 5, "#9a6533");
    const wag = motion ? Math.round(Math.sin(time * 10) * 2) : 0;
    rect(face > 0 ? x - 13 : x + 9, floorY - 16 + wag, 4, 3, "#c48a4a");
  }

  // ------------------------------------------------------------- behaviour
  function tick(dt) {
    const target =
      world?.focus && devices.find((d) => d.entityId === world.focus.entityId);
    const key = target ? `${target.entityId}@${target.sx}` : "";
    if (key !== targetKey) {
      targetKey = key;
      if (target)
        hearth.goTo([
          { x: target.sx + (target.sx > hearth.x ? -18 : 18), y: 0 },
        ]);
    }
    if (!target && !world?.busy && motion) {
      wanderTimer -= dt;
      if (wanderTimer <= 0 && !hearth.path.length) {
        wanderTimer = 3 + Math.random() * 4;
        hearth.goTo([
          {
            x: clamp(
              hearth.x + (Math.random() - 0.5) * 160,
              16,
              Math.max(16, span - 16),
            ),
            y: 0,
          },
        ]);
      }
    }
    if (target && !hearth.path.length)
      hearth.dir = target.sx > hearth.x ? "right" : "left";
    hearth.step(dt);
    const behind = hearth.x + (hearth.dir === "left" ? 26 : -26);
    if (Math.abs(pet.x - behind) > 30 || !motion)
      pet.goTo([{ x: clamp(behind, 10, Math.max(10, span - 10)), y: 0 }]);
    pet.step(dt);
    return hearth.moving || pet.moving;
  }
  let raf = 0,
    last = performance.now(),
    visible = true;
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden || !open()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (linger > 0) {
      linger -= dt;
      if (linger <= 0) {
        renderChrome();
        if (!open()) return;
      }
    }
    tick(dt);
    const width = view.clientWidth,
      height = view.clientHeight,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      canvas.width !== Math.round(width * dpr) ||
      canvas.height !== Math.round(height * dpr)
    ) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const desired =
      span <= width
        ? -(width - span) / 2
        : clamp(hearth.x - width / 2, 0, span - width);
    scroll += motion
      ? (desired - scroll) * Math.min(1, dt * 4)
      : desired - scroll;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    rect(0, 0, width, height, "#1b2725");
    const time = now / 1000;
    for (const room of rooms) drawRoom(room, height);
    for (let i = 1; i < rooms.length; i++) {
      const x = rooms[i].left - scroll - 6;
      rect(x, 0, 6, height - 14, "#3a2d28");
      rect(x + 1, height - 52, 4, 38, "#7a5838");
    }
    for (const d of devices) drawDevice(d, height, time);
    if (store.get().pet) drawPet(height, time);
    drawHearth(height, time);
    for (const node of tags.children)
      if (node.dataset.entity) {
        const d = devices.find((x) => x.entityId === node.dataset.entity);
        if (d && !node.classList.contains("amb-dragging"))
          node.style.left = `${d.sx - scroll}px`;
      } else {
        const room = rooms.find((r) => r.name === node.textContent);
        if (room) node.style.left = `${room.left - scroll + 4}px`;
      }
    if (world?.busy) {
      bubble.hidden = false;
      bubble.textContent = world.focus?.label ?? "Hmm, thinking…";
      bubble.style.left = `${clamp(hearth.x - scroll, 70, width - 70)}px`;
    } else bubble.hidden = true;
    schedule();
  }
  function schedule() {
    if (!raf && visible && !document.hidden && open())
      raf = requestAnimationFrame(frame);
  }
  const onVisibility = () => {
    last = performance.now();
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    onVisibility();
  });
  intersection.observe(root);

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
    if (editing) setEditing(false);
    linger = 0;
    setPinned(false);
  });
  let swipe = null;
  view.addEventListener("pointerdown", (event) => {
    const target = event.target.closest?.(".amb-device");
    if (editing && target) {
      swipe = {
        kind: "device",
        entityId: target.dataset.entity,
        node: target,
        moved: false,
      };
      target.classList.add("amb-dragging");
      view.setPointerCapture(event.pointerId);
      event.preventDefault();
    } else swipe = { kind: "swipe", y: event.clientY, moved: false };
  });
  view.addEventListener("pointermove", (event) => {
    if (!swipe) return;
    if (swipe.kind === "device") {
      const box = view.getBoundingClientRect();
      swipe.x = clamp(event.clientX - box.left + scroll, 0, span);
      swipe.node.style.left = `${swipe.x - scroll}px`;
      swipe.moved = true;
    } else if (swipe.y - event.clientY > 30 && !editing) {
      swipe = null;
      linger = 0;
      setPinned(false);
    }
  });
  const drop = () => {
    if (swipe?.kind === "device" && swipe.moved) {
      const room =
        rooms.find((r) => swipe.x >= r.left && swipe.x <= r.left + r.width) ??
        rooms[rooms.length - 1];
      const fx = clamp((swipe.x - room.left) / room.width, 0, 1);
      const entityId = swipe.entityId;
      store.update((layout) => {
        const previous = layout.devices[entityId];
        layout.devices[entityId] = {
          room: room.id,
          fx,
          fy: previous?.fy ?? 0.5,
        };
      });
    }
    swipe?.node?.classList.remove("amb-dragging");
    const moved = swipe?.moved;
    swipe = null;
    if (moved) renderTags();
  };
  view.addEventListener("pointerup", drop);
  view.addEventListener("pointercancel", drop);
  tags.addEventListener("click", (event) => {
    const target = event.target.closest?.(".amb-device");
    if (!target || editing) return;
    selected =
      selected === target.dataset.entity ? null : target.dataset.entity;
    renderCard();
  });
  editButton.addEventListener("click", () => setEditing(!editing));
  function setPinned(next) {
    pinned = next;
    renderChrome();
    schedule();
  }
  function setEditing(next) {
    editing = next;
    if (editing) {
      editPanel = createEditPanel(ctx, { onDone: () => setEditing(false) });
      editPanel.setDevices(world?.devices ?? []);
      editHost.replaceChildren(editPanel.element);
    } else {
      editPanel?.destroy();
      editPanel = null;
      editHost.replaceChildren();
    }
    renderChrome();
    renderTags();
    schedule();
  }
  const unsubscribe = store.subscribe(() => {
    layoutStrip();
    renderTags();
    schedule();
  });
  layoutStrip();
  renderChrome();
  renderCard();

  return {
    update(next) {
      world = next;
      if (wasBusy && !world.busy) linger = motion ? 2.5 : 1;
      wasBusy = world.busy;
      layoutStrip();
      editPanel?.setDevices(world.devices);
      renderChrome();
      renderCard();
      renderTags();
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      editPanel?.destroy();
      root.remove();
    },
  };
}
