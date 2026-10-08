// Browser side of "Set up my Home World with Hearth": attached-image
// thumbnails in the transcript, the chat proposal card and the house
// preview banner with Keep / Discard, rendered with textContent only.
// Synthetic data; linkedom DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

function withDocument() {
  const { window, document } = parseHTML(
    '<html><body><div id="chat"></div><div id="strip"></div><div id="main"></div></body></html>',
  );
  const previous = { document: globalThis.document, window: globalThis.window };
  // linkedom's <select> has no value setter; the editor sets it.
  const select = (
    window as unknown as { HTMLSelectElement: { prototype: object } }
  ).HTMLSelectElement.prototype;
  Object.defineProperty(select, "value", {
    configurable: true,
    get(this: { getAttribute(n: string): string | null }) {
      return this.getAttribute("data-value") ?? "";
    },
    set(this: { setAttribute(n: string, v: string): void }, v: string) {
      this.setAttribute("data-value", String(v));
    },
  });
  Object.assign(globalThis, { document, window });
  return {
    document,
    window,
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}
const malicious = "<img src=x onerror=alert(1)><script>alert(2)</script>";

test("user messages show attached images from the owner-checked route, never bytes or data URLs", async () => {
  const dom = withDocument();
  try {
    const { renderMessages, renderWorldProposal } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const chat = dom.document.getElementById("chat")!;
    renderMessages(chat, {
      view: {
        conversation: { id: 12 },
        entries: [
          {
            id: 40,
            model: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Here is my plan" },
                  { type: "image", mimeType: "image/jpeg", image: "40/0" },
                  // Malformed references are ignored.
                  { type: "image", mimeType: "image/png", image: "../x" },
                  { type: "image", mimeType: "image/png", data: "AAAA" },
                ],
              },
            ],
          },
          {
            id: 41,
            model: [
              {
                role: "user",
                content: [
                  { type: "image", mimeType: "image/png", image: "41/0" },
                ],
              },
            ],
          },
        ],
        docs: {},
      },
    });
    const images = [...chat.querySelectorAll("img")] as HTMLImageElement[];
    assert.deepEqual(
      images.map((i) => i.getAttribute("src")),
      ["api/sessions/12/images/40/0", "api/sessions/12/images/41/0"],
    );
    assert.equal(images[0]!.getAttribute("alt"), "Attached image 1");
    // An image-only message still renders.
    assert.equal(chat.querySelectorAll("article.message.user").length, 2);
    assert(!chat.innerHTML.includes("data:"));

    // The proposal card: plain text, a single preview button.
    let opened = 0;
    const card = renderWorldProposal(
      {
        role: "toolResult",
        toolName: "world_layout_propose",
        isError: false,
        content: [{ type: "text", text: "{}" }],
        details: {
          ok: true,
          kind: "home_world_proposal",
          draftId: "wd_synthetic",
          rooms: 8,
          decor: 1,
          cols: 28,
          rows: 21,
          note: malicious,
          warnings: [],
        },
      },
      () => opened++,
    )!;
    assert(card);
    assert.match(card.textContent!, /Home layout proposal/);
    assert.match(card.textContent!, /8 rooms \+ 1 outdoor space · 28×21/);
    assert.match(card.textContent!, /nothing is saved until you tap Keep/);
    assert(card.textContent!.includes(malicious));
    assert.equal(card.querySelector("script"), null);
    assert.equal(card.querySelector("img"), null);
    const buttons = [...card.querySelectorAll("button")];
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["Open preview"],
    );
    buttons[0]!.dispatchEvent(new dom.window.Event("click"));
    assert.equal(opened, 1);
    // Errors and other results never become a card.
    assert.equal(
      renderWorldProposal(
        {
          role: "toolResult",
          toolName: "world_layout_propose",
          isError: true,
          content: [{ type: "text", text: '{"ok":false}' }],
        },
        () => {},
      ),
      null,
    );
    // Without details (older transcript), the JSON content is used.
    assert(
      renderWorldProposal(
        {
          role: "toolResult",
          toolName: "world_layout_propose",
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                kind: "home_world_proposal",
                rooms: 2,
                decor: 0,
                cols: 16,
                rows: 6,
              }),
            },
          ],
        },
        () => {},
      ),
    );
  } finally {
    dom.restore();
  }
});

const SAVED = {
  revision: 3,
  customized: false,
  migrated: true,
  registry: "ok",
  grid: { cols: 16, rows: 6 },
  levels: [],
  rooms: [
    {
      id: "area:study",
      name: "Study",
      x: 0,
      y: 0,
      w: 8,
      h: 6,
      floor: "carpet",
      level: "",
      area: "Study",
    },
    {
      id: "area:living",
      name: "Living",
      x: 8,
      y: 0,
      w: 8,
      h: 6,
      floor: "wood",
      level: "",
      area: "Living",
    },
  ],
  devices: [
    {
      entityId: "light.study_lamp",
      room: "area:study",
      fx: 0.5,
      fy: 0.5,
      area: "Study",
      device: null,
      moved: false,
    },
  ],
  character: { palette: 0, hat: "beanie" },
  pet: true,
  custom: null,
  draft: {
    id: "wd_synthetic",
    conversationId: 4,
    created: 1,
    expires: 2,
    note: "Two rooms and a balcony",
    rooms: 2,
    decor: 1,
    cols: 28,
    rows: 10,
  },
};
const DRAFT = {
  ...SAVED,
  customized: true,
  preview: true,
  grid: { cols: 28, rows: 10 },
  rooms: [
    { ...SAVED.rooms[0], x: 0, y: 0, w: 14, h: 7 },
    { ...SAVED.rooms[1], x: 14, y: 0, w: 14, h: 7 },
    {
      id: "decor:balcony",
      name: "Balcony",
      x: 14,
      y: 7,
      w: 10,
      h: 3,
      floor: "grass",
      level: "",
      area: null,
      decor: true,
    },
  ],
};

test("Home World preview: labelled banner, Keep with the saved revision, Discard, editor off", async () => {
  const dom = withDocument();
  const calls: [string, unknown][] = [];
  const world = await import(
    new URL("../public/world/world.js", import.meta.url).href
  );
  let shown: HTMLElement | null = null;
  try {
    const host = {
      api: {
        load: async () => structuredClone(SAVED),
        values: async () => ({ values: {}, controls: {}, night: false }),
        save: async () => assert.fail("no save during preview"),
        reset: async () => assert.fail("no reset"),
        migrate: async () => assert.fail("no migrate"),
        draft: async () => {
          calls.push(["draft", null]);
          return structuredClone(DRAFT);
        },
        keepDraft: async (body: unknown) => {
          calls.push(["keep", body]);
          return {
            ...structuredClone(DRAFT),
            preview: undefined,
            revision: 4,
            draft: null,
          };
        },
        discardDraft: async (body: unknown) => {
          calls.push(["discard", body]);
          return { ...structuredClone(SAVED), draft: null };
        },
      },
      toggle: async () => "",
      ask: (prompt: string) => calls.push(["ask", prompt]),
      showView: (element: HTMLElement | null) => {
        shown = element;
      },
      stripHost: dom.document.getElementById("strip")!,
    };
    const mounted = await world.mountWorld(host);
    mounted.update({ snapshot: null, kind: "home", canDraft: true });
    mounted.openFull();
    const view = () => shown!;
    const banner = () => view().querySelector(".wh-banner") as HTMLElement;
    // A pending proposal is pointed out quietly.
    assert.equal(banner().hidden, false);
    assert.match(banner().textContent!, /Hearth proposed a new layout/);
    // Open the preview.
    mounted.openFull({ preview: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls[0], ["draft", null]);
    assert.match(banner().textContent!, /Preview · Hearth's proposal/);
    assert.match(
      banner().textContent!,
      /2 rooms \+ 1 outdoor space · 28×10 · not saved yet/,
    );
    assert(view().classList.contains("wh-previewing"));
    const tools = [
      ...view().querySelectorAll(".wh-tool"),
    ] as HTMLButtonElement[];
    const edit = tools.find((b) => b.textContent === "Edit")!;
    assert.equal(edit.hidden, true, "editor disabled during preview");
    // The list view shows the draft too.
    const list = tools.find((b) => b.textContent === "List")!;
    list.dispatchEvent(new dom.window.Event("click"));
    assert.match(view().querySelector(".wh-list")!.textContent!, /Balcony/);
    const buttons = [
      ...banner().querySelectorAll("button"),
    ] as HTMLButtonElement[];
    const keep = buttons.find((b) => b.textContent === "Keep")!;
    const discard = buttons.find((b) => b.textContent === "Discard")!;
    assert(!keep.hidden && !discard.hidden);
    keep.dispatchEvent(new dom.window.Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls[1], [
      "keep",
      { baseRevision: 3, draftId: "wd_synthetic" },
    ]);
    assert.equal(banner().hidden, true);
    assert.match(view().textContent!, /Kept\. This is your Home World now/);
    // Discard path on a fresh preview.
    mounted.openFull({ preview: true });
    await new Promise((r) => setTimeout(r, 0));
    const again = [
      ...banner().querySelectorAll("button"),
    ] as HTMLButtonElement[];
    again
      .find((b) => b.textContent === "Discard")!
      .dispatchEvent(new dom.window.Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls[3], ["discard", { draftId: "wd_synthetic" }]);
    assert.match(
      view().textContent!,
      /Discarded\. Your Home World is unchanged/,
    );
    mounted.closeFull();
    // "Set up with Hearth…" in the editor only drafts the request.
    mounted.openFull({ edit: true });
    const setup = [...shown!.querySelectorAll("button")].find(
      (b) => b.textContent === "Set up with Hearth…",
    ) as HTMLButtonElement;
    assert(setup, "setup button in the editor");
    setup.dispatchEvent(new dom.window.Event("click"));
    assert.equal(calls[calls.length - 1]![0], "ask");
    assert.match(String(calls[calls.length - 1]![1]), /^Set up my Home World/);
    mounted.closeFull();
  } finally {
    dom.restore();
  }
});

test("composer offers image attachments with a file picker; CSP allows only self and blob images", async () => {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="attach-input"[\s\S]*?accept="image\/\*"/);
  assert.match(html, /aria-label="Attach images"/);
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  for (const route of [
    'api("world/draft")',
    'api("world/draft/keep"',
    'api("world/draft/discard"',
  ])
    assert(app.includes(route), route);
  assert.match(app, /ATTACH_SIDE = 2048/);
  assert.match(app, /toBlob\(resolve, "image\/jpeg"/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
  const server = await readFile(
    new URL("../src/server.ts", import.meta.url),
    "utf8",
  );
  assert.match(server, /img-src 'self' blob:;/);
  assert.doesNotMatch(server, /img-src[^;]*data:/);
});
