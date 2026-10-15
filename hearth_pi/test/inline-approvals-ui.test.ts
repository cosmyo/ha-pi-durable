// Inline approval cards in the transcript (public/render.js) against a
// synthetic DOM: placement right after the proposing tool call's activity
// group, exactly once, linked only by the controller-set details of a known
// proposal tool's result; everything else stays in the approvals section.
// Collapsible cards: defaults, a remembered choice, accessible summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { PROPOSAL_TOOLS } from "../src/proposal-tools.js";

const { document, Event } = parseHTML(
  '<html><body><div id="chat"></div><div id="approvals"></div></body></html>',
);
Object.defineProperty(globalThis, "document", {
  value: document,
  configurable: true,
});
const render = await import(
  new URL("../public/render.js", import.meta.url).href
);
const chat = () => document.getElementById("chat")!;
const approvals = () => document.getElementById("approvals")!;

const NOW = Date.now();
type P = Record<string, unknown> & { id: string; status: string };
const proposal = (id: string, status: string, extra = {}): P => ({
  id,
  hash: `hash-${id}`,
  status,
  created: NOW - Number(id),
  expires: NOW + 600000,
  action: {
    kind: "flow",
    op: "init",
    handler: "example_tv",
  },
  risk: { level: "high", rule: "integration_setup", reasons: [] },
  ...extra,
});
const user = (text: string) => ({ role: "user", content: text });
const call = (id: string, name: string) => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [{ type: "toolCall", id, name, arguments: { handler: "x" } }],
});
const result = (id: string, name: string, details?: unknown) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  isError: false,
  content: [{ type: "text", text: '{"ok":true}' }],
  ...(details === undefined ? {} : { details }),
});
const reply = (text: string) => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text }],
});
const snapshot = (model: unknown[][], live: unknown = {}) => ({
  view: {
    entries: model.map((m, i) => ({ id: i + 1, model: m })),
    docs: { "pi.live": live },
  },
});
// What app.js does: the transcript, then the approvals section with the
// proposals not shown inline.
function paint(
  view: ReturnType<typeof snapshot>,
  proposals: Record<string, P>,
  decide: (...args: unknown[]) => void = () => {},
  choices = new Map<string, boolean>(),
  canApprove = true,
) {
  const shown = render.renderMessages(chat(), view, undefined, undefined, {
    proposals,
    card: (p: P) =>
      render.buildInlineProposal(p, proposals, decide, canApprove, choices),
  });
  render.renderProposals(approvals(), proposals, decide, canApprove, shown);
  return shown as Set<string>;
}
const kinds = () =>
  [...chat().children].map((el) =>
    el.classList.contains("proposal-inline")
      ? `card:${el.getAttribute("data-proposal-id")}`
      : el.classList.contains("activity")
        ? "activity"
        : el.classList.contains("user")
          ? "user"
          : el.classList.contains("live")
            ? "live"
            : "assistant",
  );

test("a proposal card sits right after the activity group of the tool call that filed it, before the later reply, and not in the approvals section", () => {
  const proposals = { "41": proposal("41", "pending") };
  const shown = paint(
    snapshot([
      [user("Set up the TV")],
      [call("c1", "ha_flow_propose")],
      [result("c1", "ha_flow_propose", { proposalId: "41" })],
      [reply("Done.")],
    ]),
    proposals,
  );
  assert.deepEqual(kinds(), ["user", "activity", "card:41", "assistant"]);
  assert.deepEqual([...shown], ["41"]);
  assert.equal(approvals().children.length, 0);
  // The card body is the same exact action card as in the approvals section.
  const card = chat().querySelector(".proposal-inline .action-card")!;
  assert.match(card.textContent!, /Set up example_tv · pending/);
  assert.match(card.textContent!, /Exact immutable fingerprint/);
});

test("each proposal is shown exactly once: a second result naming the same id adds no card; other proposals stay in the approvals section", () => {
  const proposals = {
    "41": proposal("41", "pending"),
    "42": proposal("42", "accepted", {
      origin: { kind: "app", appId: "a", elementId: "e", version: 1 },
    }),
  };
  const shown = paint(
    snapshot([
      [call("c1", "ha_flow_propose")],
      [result("c1", "ha_flow_propose", { proposalId: "41" })],
      [reply("Filed.")],
      [call("c2", "ha_flow_propose")],
      [result("c2", "ha_flow_propose", { proposalId: "41" })],
      [reply("Same receipt.")],
    ]),
    proposals,
  );
  assert.deepEqual(kinds(), [
    "activity",
    "card:41",
    "assistant",
    "activity",
    "assistant",
  ]);
  assert.equal(chat().querySelectorAll(".action-card").length, 1);
  assert.deepEqual([...shown], ["41"]);
  // The app press (no tool result) stays in the approvals section.
  const cards = approvals().querySelectorAll(".action-card");
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.textContent!, /Requested by you from app a/);
});

test("legacy history without details, spoofed details (a non-proposal tool, an unknown id, a non-string id) and no card hook all fall back to the approvals section", () => {
  const proposals = {
    "41": proposal("41", "accepted"),
    "43": proposal("43", "pending"),
  };
  const shown = paint(
    snapshot([
      // Legacy: a proposal tool result from before details existed.
      [call("c1", "ha_call_service")],
      [result("c1", "ha_call_service")],
      // Spoofed: details on a tool that never files proposals.
      [call("c2", "ha_search_states")],
      [result("c2", "ha_search_states", { proposalId: "43" })],
      // Unknown id, non-string id and an id given only in the tool text.
      [call("c3", "ha_call_service")],
      [result("c3", "ha_call_service", { proposalId: "999" })],
      [call("c4", "ha_call_service")],
      [result("c4", "ha_call_service", { proposalId: 43 })],
      [
        {
          ...result("c5", "ha_call_service"),
          content: [{ type: "text", text: '{"id":"43"}' }],
        },
      ],
      [reply("Done.")],
    ]),
    proposals,
  );
  assert.equal(shown.size, 0);
  assert.equal(chat().querySelector(".proposal-inline"), null);
  assert.equal(approvals().querySelectorAll(".action-card").length, 2);
  assert.equal(
    render.linkedProposalId(
      {
        role: "assistant",
        toolName: "ha_call_service",
        details: { proposalId: "41" },
      },
      proposals,
    ),
    null,
  );
  assert.equal(
    render.linkedProposalId(
      result("c", "list_propose", { proposalId: "41" }),
      proposals,
    ),
    "41",
  );
  assert.equal(
    render.linkedProposalId(
      result("c", "list_propose", { proposalId: "toString" }),
      proposals,
    ),
    null,
  );
  // Without the card hook (other callers) nothing is placed inline.
  const plain = render.renderMessages(
    chat(),
    snapshot([
      [call("c1", "ha_flow_propose")],
      [result("c1", "ha_flow_propose", { proposalId: "41" })],
    ]),
  );
  assert.equal(plain.size, 0);
  assert.equal(chat().querySelector(".proposal-inline"), null);
});

test("live turn: the card appears right after its tool result while Hearth is still answering, before the live reply", () => {
  const proposals = { "41": proposal("41", "pending") };
  paint(
    snapshot(
      [
        [user("Set up the TV")],
        [call("c1", "ha_flow_propose")],
        [result("c1", "ha_flow_propose", { proposalId: "41" })],
      ],
      {
        run: { taskId: "t", inputs: ["s"] },
        generation: {
          attempt: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Waiting for your approval" }],
          },
        },
      },
    ),
    proposals,
  );
  assert.deepEqual(kinds(), ["user", "activity", "card:41", "live"]);
});

test("running proposal tool: the card is inline right after its call while the tool still runs (Full access dispatch), linked only by the live slot's task id; other slots fall back", () => {
  const proposals = {
    "41": proposal("41", "dispatching"),
    "52": proposal("52", "pending"),
    "53": proposal("53", "pending"),
  };
  const slots = [
    { callId: "c1", name: "ha_flow_propose", taskId: 41, status: "running" },
    // A non-proposal tool whose task id happens to equal a proposal id.
    { callId: "c2", name: "ha_admin_read", taskId: 52, status: "running" },
    // A slot whose name does not match the transcript call.
    { callId: "c3", name: "ha_admin_read", taskId: 53, status: "running" },
  ];
  paint(
    snapshot(
      [
        [user("Set up the TV")],
        [
          call("c1", "ha_flow_propose"),
          call("c2", "ha_admin_read"),
          call("c3", "ha_flow_propose"),
        ],
      ],
      { run: { taskId: "t", inputs: ["s"] }, tools: slots },
    ),
    proposals,
  );
  assert.deepEqual(kinds().slice(0, 3), ["user", "activity", "card:41"]);
  assert.equal(chat().querySelectorAll(".proposal-inline").length, 1);
  assert.equal(approvals().querySelectorAll(".action-card").length, 2);
  // Once the result lands, the same proposal stays inline exactly once.
  paint(
    snapshot([
      [user("Set up the TV")],
      [call("c1", "ha_flow_propose")],
      [result("c1", "ha_flow_propose", { proposalId: "41" })],
    ]),
    { "41": proposal("41", "accepted") },
  );
  assert.deepEqual(kinds(), ["user", "activity", "card:41"]);
});

test("pending inline card: Approve and Reject are wired to decide; a critical card needs the typed word; read-only blocks Approve", () => {
  const decisions: unknown[][] = [];
  const decide = (...args: unknown[]) => decisions.push(args);
  const pending = proposal("41", "pending");
  const critical = proposal("44", "pending", {
    risk: { level: "critical", rule: "remote_access", reasons: [] },
    confirmation: "example_tv",
  });
  const proposals = { "41": pending, "44": critical };
  const view = snapshot([
    [call("c1", "ha_flow_propose")],
    [result("c1", "ha_flow_propose", { proposalId: "41" })],
    [call("c2", "ha_flow_propose")],
    [result("c2", "ha_flow_propose", { proposalId: "44" })],
  ]);
  paint(view, proposals, decide);
  const [first, second] = [...chat().querySelectorAll(".proposal-inline")];
  const buttons = (el: Element) =>
    [
      ...el.querySelectorAll(".action-card .actions button"),
    ] as HTMLButtonElement[];
  const [approve, reject] = buttons(first!);
  assert.equal(approve!.textContent, "Approve exact action");
  assert.equal(approve!.disabled, false);
  approve!.dispatchEvent(new Event("click"));
  reject!.dispatchEvent(new Event("click"));
  assert.deepEqual(decisions, [
    [pending, "approve", ""],
    [pending, "reject", ""],
  ]);
  const [critApprove] = buttons(second!);
  const input = second!.querySelector(".confirm-input") as HTMLInputElement;
  assert.equal(critApprove!.disabled, true);
  input.value = "example_tv";
  input.dispatchEvent(new Event("input"));
  assert.equal(critApprove!.disabled, false);
  critApprove!.dispatchEvent(new Event("click"));
  assert.deepEqual(decisions.at(-1), [critical, "approve", "example_tv"]);
  paint(view, proposals, () => assert.fail("no decision"), new Map(), false);
  const [blocked, stillReject] = buttons(
    chat().querySelector(".proposal-inline")!,
  );
  assert.equal(blocked!.disabled, true);
  assert.equal(stillReject!.disabled, false);
});

test("collapsible: pending and unknown open; accepted, rejected, failed, resolved, running and expired collapsed; the summary says status, risk and whether approval is needed", () => {
  const cases: [P, boolean, string][] = [
    [
      proposal("1", "pending"),
      true,
      "Set up example_tv, Pending, High risk, Approval needed",
    ],
    [
      proposal("2", "unknown"),
      true,
      "Set up example_tv, Outcome unknown, High risk, Needs resolution",
    ],
    [
      proposal("3", "accepted"),
      false,
      "Set up example_tv, Accepted, High risk",
    ],
    [
      proposal("4", "rejected"),
      false,
      "Set up example_tv, Rejected, High risk",
    ],
    [proposal("5", "failed"), false, "Set up example_tv, Failed, High risk"],
    [
      proposal("6", "resolved"),
      false,
      "Set up example_tv, Resolved, High risk",
    ],
    [
      proposal("7", "dispatching"),
      false,
      "Set up example_tv, Running, High risk",
    ],
    [
      proposal("8", "pending", { expires: NOW - 1 }),
      false,
      "Set up example_tv, Expired, High risk",
    ],
  ];
  for (const [p, open, text] of cases) {
    const card = render.buildInlineProposal(
      p,
      { [p.id]: p },
      () => {},
      true,
      new Map(),
    );
    const details = card.querySelector("details")!;
    const summary = details.firstElementChild!;
    assert.equal(summary.tagName, "SUMMARY", p.status);
    assert.equal(details.hasAttribute("open"), open, `${p.id} ${p.status}`);
    assert.equal(summary.textContent, text);
    // No inline handlers; the summary is the native, focusable control.
    assert.equal(card.querySelector("[onclick],[ontoggle]"), null);
    assert.equal(summary.querySelector("button,a,input"), null);
  }
});

test("collapsible: the person's open/closed choice survives re-renders and status changes; without a choice the default follows the status", () => {
  const choices = new Map<string, boolean>();
  let proposals: Record<string, P> = { "41": proposal("41", "pending") };
  const view = snapshot([
    [call("c1", "ha_flow_propose")],
    [result("c1", "ha_flow_propose", { proposalId: "41" })],
  ]);
  const details = () => chat().querySelector(".proposal-inline details")!;
  paint(view, proposals, () => {}, choices);
  assert.equal(details().hasAttribute("open"), true);
  // The person collapses the pending card (a click; the browser toggles).
  details().querySelector("summary")!.dispatchEvent(new Event("click"));
  assert.equal(choices.get("41"), false);
  paint(view, proposals, () => {}, choices);
  assert.equal(details().hasAttribute("open"), false);
  // Collapsed, it still says approval is needed.
  assert.match(
    details().querySelector("summary")!.textContent!,
    /Approval needed/,
  );
  // Status change: the choice still wins.
  proposals = { "41": proposal("41", "accepted") };
  paint(view, proposals, () => {}, choices);
  assert.equal(details().hasAttribute("open"), false);
  // Re-opened, an accepted card stays open across re-renders.
  details().removeAttribute("open");
  details().querySelector("summary")!.dispatchEvent(new Event("click"));
  assert.equal(choices.get("41"), true);
  paint(view, proposals, () => {}, choices);
  assert.equal(details().hasAttribute("open"), true);
  // Without a choice: pending opens, and it collapses once accepted.
  const fresh = new Map<string, boolean>();
  paint(view, { "41": proposal("41", "pending") }, () => {}, fresh);
  assert.equal(details().hasAttribute("open"), true);
  paint(view, { "41": proposal("41", "accepted") }, () => {}, fresh);
  assert.equal(details().hasAttribute("open"), false);
});

test("inline card CSS: a 44px summary line, phone layout, and render.js builds DOM only with textContent", async () => {
  const css = await readFile(
    new URL("../public/app.css", import.meta.url),
    "utf8",
  );
  const rule = /\.proposal-inline-summary\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /min-height:\s*var\(--touch-target\)/);
  assert.match(rule, /list-style:\s*none/);
  assert.match(css, /\.proposal-inline-summary::-webkit-details-marker/);
  const source = await readFile(
    new URL("../public/render.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
});

test("PROPOSAL_TOOLS: the browser's list equals the server's, and every HomeActions.request tool returns proposalToolResult", async () => {
  assert.deepEqual(
    [...render.PROPOSAL_TOOLS].sort(),
    [...PROPOSAL_TOOLS].sort(),
  );
  for (const file of ["ha.ts", "ha-admin.ts", "lists.ts"]) {
    const source = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    const requests = source.match(/actions\.request\(/g)?.length ?? 0;
    const linked =
      source.match(/proposalToolResult\(\s*await ha\.actions\.request\(/g)
        ?.length ?? 0;
    assert.ok(requests > 0, file);
    assert.equal(linked, requests, `${file}: every request is linked`);
  }
});
