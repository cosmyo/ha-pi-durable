import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("approval cards render every admin action kind with a risk badge, rule, judge note and a critical typed confirmation", async () => {
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
  try {
    const { renderProposals, toYaml } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const base = {
      hash: "a".repeat(64),
      policy: "p",
      created: 1,
      expires: Date.now() + 60000,
      status: "pending",
      decidedBy: "",
      decidedAt: 0,
      resolution: "",
    };
    const hostile = "<img src=x onerror=alert(1)>";
    const proposals = {
      "1": {
        ...base,
        id: "1",
        action: {
          kind: "service",
          domain: "climate",
          service: "set_temperature",
          target: { entity_id: ["climate.hall"] },
          data: { temperature: 20, note: hostile },
        },
        risk: { level: "medium", rule: "household_device", reasons: ["x"] },
        judge: {
          model: "openai-codex/gpt-5.6-luna",
          verdict: "misaligned",
          reason: "Owner asked about the kitchen",
          latencyMs: 412,
        },
      },
      "2": {
        ...base,
        id: "2",
        created: 2,
        action: {
          kind: "config",
          resource: "automation",
          op: "upsert",
          id: "porch_lights",
          body: { alias: "Porch", action: [{ action: "light.turn_on" }] },
        },
        risk: { level: "medium", rule: "config_write", reasons: ["y"] },
        judge: { model: "off", verdict: "off", reason: "", latencyMs: 0 },
      },
      "3": {
        ...base,
        id: "3",
        created: 3,
        action: { kind: "supervisor", method: "POST", path: "/host/reboot" },
        risk: { level: "critical", rule: "host_power", reasons: ["z"] },
        judge: { model: "off", verdict: "off", reason: "", latencyMs: 0 },
        confirmation: "REBOOT",
      },
    };
    const decisions: unknown[][] = [];
    const container = document.getElementById("cards")!;
    renderProposals(container, proposals, (...args: unknown[]) =>
      decisions.push(args),
    );
    const html = container.innerHTML;
    assert(!html.includes("<img"), "untrusted text is never markup");
    const text = container.textContent!;
    assert.match(text, /climate\.set_temperature · pending/);
    assert.match(text, /entity: climate\.hall/);
    assert.match(text, /Write automation porch_lights/);
    assert.match(text, /alias: Porch/);
    assert.match(text, /- action: light\.turn_on/);
    assert.match(text, /Supervisor POST \/host\/reboot/);
    assert.match(text, /Owner asked about the kitchen/);
    assert.match(text, /rule host_power/);
    const badges = [...container.querySelectorAll(".risk-badge")].map(
      (b) => (b as HTMLElement).className,
    );
    assert.deepEqual(badges.sort(), [
      "risk-badge risk-critical",
      "risk-badge risk-medium",
      "risk-badge risk-medium",
    ]);
    // Critical: approve stays disabled until the exact word is typed.
    const cards = [...container.querySelectorAll(".action-card")];
    const critical = cards.find((c) =>
      c.textContent!.includes("/host/reboot"),
    )!;
    const input = critical.querySelector(".confirm-input") as HTMLInputElement;
    const approve = critical.querySelector(".approve") as HTMLButtonElement;
    assert(input && approve.disabled);
    input.value = "reboot";
    input.dispatchEvent(new window.Event("input"));
    assert(approve.disabled);
    input.value = "REBOOT";
    input.dispatchEvent(new window.Event("input"));
    assert(!approve.disabled);
    approve.dispatchEvent(new window.Event("click"));
    assert.equal(decisions.at(-1)![1], "approve");
    assert.equal(decisions.at(-1)![2], "REBOOT");
    assert.equal(toYaml({ a: [] }), "a: []");
    // Keys that are not plain words are JSON-quoted: they cannot fake lines,
    // list items, comments or nesting on the approval card.
    const weird = toYaml({
      "action:\n  - service: hassio.host_reboot": 1,
      "- fake": 2,
      "# note": 3,
      "a: b": 4,
      ok_key: 5,
    });
    assert.equal(
      weird,
      [
        '"action:\\n  - service: hassio.host_reboot": 5'.replace(": 5", ": 1"),
        '"- fake": 2',
        '"# note": 3',
        '"a: b": 4',
        "ok_key: 5",
      ].join("\n"),
    );
    assert.equal(weird.split("\n").length, 5);
  } finally {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  }
});

test("Settings shows Access and Risk judge read-only, with how to change them in the App configuration", async () => {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="access-mode-row"/);
  assert.match(html, /id="judge-model-row"/);
  assert.match(html, /access_mode,\s+risk_judge_model/);
  // Read-only display rows: not buttons, no form controls.
  assert.match(html, /<div\s+id="access-row"/);
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /"Admin" : "Scoped"/);
  assert.doesNotMatch(app, /access_mode"?\s*:/, "the UI never sends access");
});
