import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("approval cards say when a proposal was sent to and decided from the phone", async () => {
  const { parseHTML } = await import("linkedom");
  const { document, window } = parseHTML(
    '<html><body><div id="cards"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: window,
    configurable: true,
  });
  const { renderProposals } = await import(
    new URL("../public/render.js", import.meta.url).href
  );
  const base = {
    hash: "a".repeat(64),
    policy: "p",
    expires: Date.now() + 60000,
    decidedBy: "",
    decidedAt: 0,
    resolution: "",
    action: {
      service: "light.turn_on",
      entityId: "light.example_lamp",
      data: {},
    },
    risk: { level: "low", rule: "low_domain", reasons: [] },
  };
  const container = document.getElementById("cards")!;
  renderProposals(
    container,
    {
      "1": {
        ...base,
        id: "1",
        created: 1,
        status: "pending",
        notified: { at: 1, tag: "hearth_0123456789abcdef", count: 1 },
      },
      "2": {
        ...base,
        id: "2",
        created: 2,
        status: "accepted",
        decidedVia: "push",
      },
      "3": {
        ...base,
        id: "3",
        created: 3,
        status: "rejected",
        decidedVia: "push",
      },
      "4": { ...base, id: "4", created: 4, status: "pending" },
    },
    () => {},
  );
  const cards = [...container.querySelectorAll(".action-card")].map(
    (c) => (c as HTMLElement).textContent ?? "",
  );
  // Newest first.
  assert.doesNotMatch(cards[0]!, /phone/);
  assert.match(cards[1]!, /Rejected from your phone/);
  assert.match(cards[2]!, /Approved from your phone/);
  assert.match(cards[3]!, /Sent to your phone/);
});

test("Settings → You has a hidden-by-default Phone approvals switch with the explainer", async () => {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const section = document.getElementById("push-section")!;
  assert.ok(section.hasAttribute("hidden"));
  assert.ok(section.closest("#you-dialog"));
  const toggle = document.getElementById("push-enabled")!;
  assert.equal(toggle.getAttribute("role"), "switch");
  assert.match(
    (section.textContent ?? "").replace(/\s+/g, " "),
    /Low and medium can be approved from the notification; high and critical open Hearth\./,
  );
  // Rendered with textContent only: the new code builds no HTML strings.
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = app.indexOf("Phone approvals (opt-in App option)");
  const end = app.indexOf("function openYou()");
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(app.slice(start, end), /innerHTML|insertAdjacentHTML/);
});
