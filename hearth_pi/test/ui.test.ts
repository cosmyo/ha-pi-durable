import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

test("UI renders model/entity/tool/action data as text, not executable HTML; exact review binding", async () => {
  const { document, Event } = parseHTML(
    '<html><body><div id="chat"></div><div id="actions"></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    value: document,
    configurable: true,
  });
  try {
    const { renderMessages, renderProposals } = await import(
      new URL("../public/render.js", import.meta.url).href
    );
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const chat = document.getElementById("chat")!;
    renderMessages(chat, {
      view: {
        entries: [
          {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: malicious }],
              },
            ],
          },
          {
            model: [
              {
                role: "toolResult",
                content: [{ type: "text", text: malicious }],
              },
            ],
          },
        ],
        docs: { "pi.live": {} },
      },
    });
    assert(chat.textContent!.includes(malicious));
    assert.equal(chat.querySelector("img"), null);
    assert.equal(chat.querySelector("script"), null);
    const container = document.getElementById("actions")!;
    const decisions: unknown[] = [];
    const p = {
      id: "123",
      hash: "original-immutable-hash",
      action: {
        service: "light.turn_on",
        entityId: malicious,
        data: { brightness: 8 },
      },
      status: "pending",
      created: Date.now(),
      expires: Date.now() + 10000,
      resolution: malicious,
    };
    renderProposals(
      container,
      { "123": p },
      (proposal: unknown, decision: unknown) =>
        decisions.push({ proposal, decision }),
    );
    assert.equal(container.querySelector("script"), null);
    assert.equal(container.querySelector("img"), null);
    assert(container.textContent!.includes(malicious));
    assert.equal(decisions.length, 0);
    container.querySelector("button")!.dispatchEvent(new Event("click"));
    assert.deepEqual(decisions, [{ proposal: p, decision: "approve" }]);
    const script = await readFile(
      new URL("../public/app.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      script,
      /innerHTML|outerHTML|insertAdjacentHTML|eval\(/,
    );
    const html = await readFile(
      new URL("../public/index.html", import.meta.url),
      "utf8",
    );
    assert.match(html, /aria-label="Conversation"/);
    assert.match(html, /maxlength="4000"/);
    assert.match(html, /type="module" src="\.\/app.js"/);
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
});
