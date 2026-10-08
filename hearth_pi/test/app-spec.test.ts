import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENTS,
  LIMITS,
  TEMPLATES,
  applyPatch,
  boundEntities,
  catalogSummary,
  describeCatalog,
  diffSpecs,
  validateSpec,
  type AppSpec,
  type ValidationContext,
} from "../src/app-spec.js";

const context: ValidationContext = {
  readable: [
    "sensor.washer_state",
    "sensor.dryer_state",
    "sensor.washer_power",
    "light.hall",
    "switch.fan",
    "sensor.private_elsewhere",
  ],
  services: [
    "light.turn_on",
    "light.turn_off",
    "switch.turn_on",
    "switch.turn_off",
  ],
};
function laundry(): Record<string, unknown> {
  return {
    specVersion: "has/1",
    title: "Laundry",
    summary: "Washer and dryer",
    scope: {
      entities: [
        "sensor.washer_state",
        "sensor.dryer_state",
        "sensor.washer_power",
      ],
    },
    root: "main",
    elements: {
      main: { type: "Stack", children: ["grid", "fold"] },
      grid: {
        type: "Grid",
        props: { columns: 2 },
        children: ["washer", "dryer"],
      },
      washer: {
        type: "EntityTile",
        props: { entity: "sensor.washer_state", label: "Washer" },
      },
      dryer: { type: "EntityValue", props: { entity: "sensor.dryer_state" } },
      fold: {
        type: "Checklist",
        props: { stateKey: "fold", items: ["Towels", "Shirts"] },
      },
    },
  };
}
type Mutable = Record<string, any>;
function mutate(change: (spec: Mutable) => void) {
  const spec = laundry() as Mutable;
  change(spec);
  return validateSpec(spec, context);
}
function errorsOf(result: ReturnType<typeof validateSpec>) {
  assert.equal(result.ok, false, "expected rejection");
  return result.ok ? [] : result.errors;
}
function expectError(
  result: ReturnType<typeof validateSpec>,
  code: string,
  path?: string,
) {
  const errors = errorsOf(result);
  const hit = errors.find(
    (e) => e.code === code && (path === undefined || e.path === path),
  );
  assert(hit, `expected ${code} at ${path}; got ${JSON.stringify(errors)}`);
  assert(hit.message.length > 0);
  return hit;
}

test("valid laundry spec is accepted and normalized with no model values", () => {
  const result = validateSpec(laundry(), context);
  assert(result.ok, JSON.stringify(result));
  assert.equal(result.spec.elements.main!.type, "Stack");
  assert.deepEqual(result.spec.elements.washer!.children, []);
  assert.deepEqual(boundEntities(result.spec), [
    "sensor.dryer_state",
    "sensor.washer_state",
  ]);
  assert.match(result.warnings.join(" "), /sensor\.washer_power.*no element/);
});
test("non-object specs and wrong specVersion are rejected", () => {
  expectError(validateSpec("nope", context), "not_object", "");
  expectError(validateSpec([], context), "not_object", "");
  expectError(
    mutate((s) => (s.specVersion = "has/2")),
    "spec_version",
    "/specVersion",
  );
});
test("unknown component type is rejected with the catalog in the hint", () => {
  const hit = expectError(
    mutate((s) => (s.elements.washer.type = "Iframe")),
    "unknown_component",
    "/elements/washer/type",
  );
  assert.match(hit.hint!, /EntityTile/);
});
test("unknown prop is rejected with allowed props", () => {
  const hit = expectError(
    mutate((s) => (s.elements.washer.props.color = "red")),
    "unknown_prop",
    "/elements/washer/props/color",
  );
  assert.match(hit.hint!, /entity, label/);
});
test("unknown element and top-level keys are rejected", () => {
  expectError(
    mutate((s) => (s.elements.washer.onClick = "x")),
    "unknown_key",
    "/elements/washer/onClick",
  );
  expectError(
    mutate((s) => (s.css = "body{}")),
    "unknown_key",
    "/css",
  );
});
test("watchers and visibleWhen are explicitly unsupported", () => {
  expectError(
    mutate((s) => (s.watchers = [])),
    "unsupported_feature",
    "/watchers",
  );
});
test("top-level id is ignored with a warning, not trusted", () => {
  const result = mutate((s) => (s.id = "app_999"));
  assert(result.ok);
  assert.match(result.warnings.join(), /Ignored top-level id/);
  assert(!("id" in result.spec));
});
test("literal value in an entity-bound prop is rejected", () => {
  const hit = expectError(
    mutate((s) => (s.elements.washer.props.state = "running")),
    "literal_value_forbidden",
    "/elements/washer/props/state",
  );
  assert.match(hit.message, /controller/);
  expectError(
    mutate((s) => (s.elements.dryer.props.value = 42)),
    "literal_value_forbidden",
    "/elements/dryer/props/value",
  );
});
test("entity prop given as a value object or number is rejected", () => {
  expectError(
    mutate(
      (s) =>
        (s.elements.washer.props.entity = {
          id: "sensor.washer_state",
          state: "on",
        }),
    ),
    "entity_binding_required",
    "/elements/washer/props/entity",
  );
  expectError(
    mutate((s) => (s.elements.dryer.props.entity = 21)),
    "entity_binding_required",
  );
});
test("entity outside scope.entities is rejected with an add-to-scope hint", () => {
  const hit = expectError(
    mutate((s) => (s.elements.washer.props.entity = "light.hall")),
    "entity_not_in_scope",
    "/elements/washer/props/entity",
  );
  assert.match(hit.hint!, /Add it to scope/);
});
test("scope entity outside Hearth's read policy is rejected", () => {
  const hit = expectError(
    mutate((s) => s.scope.entities.push("lock.front_door")),
    "entity_not_readable",
    "/scope/entities/3",
  );
  assert.match(hit.hint!, /ha_search_states/);
});
test("binding outside both scope and read policy names both problems", () => {
  const hit = expectError(
    mutate((s) => (s.elements.washer.props.entity = "camera.secret")),
    "entity_not_in_scope",
  );
  assert.match(hit.message, /outside Hearth's read scope/);
});
test("invalid and duplicate scope entities are rejected", () => {
  expectError(
    mutate((s) => s.scope.entities.push("Not An Id")),
    "invalid_entity_id",
    "/scope/entities/3",
  );
  expectError(
    mutate((s) => s.scope.entities.push("sensor.washer_state")),
    "duplicate_entity",
  );
  expectError(
    mutate((s) => (s.scope = { entities: "sensor.washer_state" })),
    "scope_entities",
  );
});
test("cycles are rejected at the referencing child path", () => {
  const result = mutate((s) => {
    s.elements.grid.children.push("main");
  });
  expectError(result, "cycle", "/elements/grid/children/2");
  const loop = mutate((s) => {
    s.elements.a = { type: "Stack", children: ["b"] };
    s.elements.b = { type: "Stack", children: ["a"] };
    s.elements.main.children.push("a");
  });
  expectError(loop, "cycle", "/elements/b/children/0");
});
test("orphans are rejected", () => {
  expectError(
    mutate((s) => (s.elements.lonely = { type: "Text", props: { text: "x" } })),
    "orphan",
    "/elements/lonely",
  );
});
test("shared children are rejected", () => {
  expectError(
    mutate((s) => s.elements.main.children.push("washer")),
    "shared_child",
    "/elements/main/children/2",
  );
});
test("missing root and missing child references are rejected", () => {
  expectError(
    mutate((s) => (s.root = "nowhere")),
    "root_missing",
    "/root",
  );
  expectError(
    mutate((s) => s.elements.main.children.push("ghost")),
    "missing_child",
    "/elements/main/children/2",
  );
});
test("depth over 6 is rejected", () => {
  const result = mutate((s) => {
    let parent = "main";
    for (let i = 0; i < 6; i++) {
      const id = `level_${i}`;
      s.elements[id] = { type: "Stack", children: [] };
      s.elements[parent].children.push(id);
      parent = id;
    }
    s.elements[parent].children.push("leaf");
    s.elements.leaf = { type: "Text", props: { text: "deep" } };
  });
  expectError(result, "depth_limit");
});
test("more than 80 elements is rejected", () => {
  const result = mutate((s) => {
    for (let i = 0; i < LIMITS.elements; i++)
      s.elements[`t_${i}`] = { type: "Text", props: { text: "x" } };
  });
  expectError(result, "element_count", "/elements");
});
test("more than 8 tabs and mismatched tab labels are rejected", () => {
  const tabs = mutate((s) => {
    const ids = Array.from({ length: 9 }, (_, i) => `tab_${i}`);
    for (const id of ids)
      s.elements[id] = { type: "Text", props: { text: id } };
    s.elements.tabs = {
      type: "Tabs",
      props: { labels: ids },
      children: ids,
    };
    s.elements.main.children.push("tabs");
  });
  expectError(tabs, "children_count", "/elements/tabs/children");
  const mismatch = mutate((s) => {
    s.elements.tabs = {
      type: "Tabs",
      props: { labels: ["One", "Two"] },
      children: ["note_one"],
    };
    s.elements.note_one = { type: "Text", props: { text: "x" } };
    s.elements.main.children.push("tabs");
  });
  expectError(mismatch, "tab_labels", "/elements/tabs/props/labels");
});
test("invalid element ids and state keys are rejected", () => {
  expectError(
    mutate(
      (s) => (s.elements["Bad-Id"] = { type: "Text", props: { text: "x" } }),
    ),
    "invalid_id",
  );
  expectError(
    mutate((s) => (s.elements.fold.props.stateKey = "../x")),
    "invalid_state_key",
    "/elements/fold/props/stateKey",
  );
});
test("duplicate state keys are rejected", () => {
  expectError(
    mutate((s) => {
      s.elements.count = {
        type: "Counter",
        props: { stateKey: "fold", label: "Loads" },
      };
      s.elements.main.children.push("count");
    }),
    "duplicate_state_key",
  );
});
test("text length limits are enforced", () => {
  expectError(
    mutate((s) => (s.title = "x".repeat(LIMITS.title + 1))),
    "text_length",
    "/title",
  );
  expectError(
    mutate((s) => (s.title = "")),
    "text_length",
    "/title",
  );
  expectError(
    mutate(
      (s) => (s.elements.fold.props.items = ["y".repeat(LIMITS.itemText + 1)]),
    ),
    "text_length",
    "/elements/fold/props/items/0",
  );
});
test("script tags, javascript: URLs and event handlers in text are rejected", () => {
  for (const hostile of [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "javascript:alert(1)",
    "click onmouseover=alert(1)",
    "${process.env}",
  ])
    expectError(
      mutate((s) => (s.title = hostile)),
      "unsafe_text",
      "/title",
    );
  // Ordinary comparisons in plain text remain allowed.
  assert(mutate((s) => (s.summary = "Power < 5 W means idle")).ok);
});
test("control characters are rejected in single-line text", () => {
  expectError(
    mutate((s) => (s.title = "Laundry\u0007")),
    "control_characters",
    "/title",
  );
});
test("children on leaf components and non-array children are rejected", () => {
  expectError(
    mutate((s) => (s.elements.washer.children = ["dryer"])),
    "children_not_allowed",
    "/elements/washer/children",
  );
  expectError(
    mutate((s) => (s.elements.main.children = "grid")),
    "children_not_array",
  );
});
test("required props and integer/enum ranges are enforced", () => {
  expectError(
    mutate((s) => delete s.elements.grid.props.columns),
    "missing_prop",
    "/elements/grid/props/columns",
  );
  expectError(
    mutate((s) => (s.elements.grid.props.columns = 4)),
    "integer_range",
  );
  expectError(
    mutate((s) => {
      s.elements.t = { type: "Text", props: { text: "x", variant: "blink" } };
      s.elements.main.children.push("t");
    }),
    "enum",
    "/elements/t/props/variant",
  );
});
test("ToggleAction only for configured light/switch services", () => {
  const add = (entity: string, services = context.services) => {
    const spec = laundry() as Mutable;
    spec.scope.entities.push(entity);
    spec.elements.toggle = { type: "ToggleAction", props: { entity } };
    spec.elements.main.children.push("toggle");
    return validateSpec(spec, { ...context, services });
  };
  assert(add("light.hall").ok);
  expectError(add("sensor.private_elsewhere"), "entity_domain");
  const hit = expectError(
    add("switch.fan", ["light.turn_on", "light.turn_off", "switch.turn_on"]),
    "action_not_in_scope",
    "/elements/toggle/props/entity",
  );
  assert.match(hit.message, /switch\.turn_off/);
  expectError(add("light.hall", []), "action_not_in_scope");
});
test("HistoryChart is bounded to 2 per app, 3 entities and 48 hours", () => {
  const chart = (hours: number, entities: string[]) => ({
    type: "HistoryChart",
    props: { entities, hours },
  });
  const ok = mutate((s) => {
    s.elements.c1 = chart(6, ["sensor.washer_power"]);
    s.elements.main.children.push("c1");
  });
  assert(ok.ok);
  expectError(
    mutate((s) => {
      s.elements.c1 = chart(49, ["sensor.washer_power"]);
      s.elements.main.children.push("c1");
    }),
    "integer_range",
  );
  expectError(
    mutate((s) => {
      for (const id of ["c1", "c2", "c3"]) {
        s.elements[id] = chart(6, ["sensor.washer_power"]);
        s.elements.main.children.push(id);
      }
    }),
    "chart_limit",
  );
});
test("oversized specs are rejected before deeper parsing", () => {
  expectError(
    mutate((s) => (s.summary = "x".repeat(LIMITS.specBytes))),
    "spec_too_large",
    "",
  );
});
test("several independent errors are all reported in one pass", () => {
  const errors = errorsOf(
    mutate((s) => {
      s.elements.washer.type = "Marquee";
      s.elements.dryer.props.value = 1;
      s.scope.entities.push("lock.door");
    }),
  );
  const codes = errors.map((e) => e.code);
  assert(codes.includes("unknown_component"));
  assert(codes.includes("literal_value_forbidden"));
  assert(codes.includes("entity_not_readable"));
});
test("configured secrets in text are redacted, not stored", () => {
  const result = validateSpec(
    { ...laundry(), summary: "token synthetic-secret-123" },
    {
      ...context,
      redact: (v) => v.split("synthetic-secret-123").join("[REDACTED]"),
    },
  );
  assert(result.ok);
  assert.equal(result.spec.summary, "token [REDACTED]");
});
test("Counter requires min below max", () => {
  expectError(
    mutate((s) => {
      s.elements.c = {
        type: "Counter",
        props: { stateKey: "loads", label: "Loads", min: 5, max: 5 },
      };
      s.elements.main.children.push("c");
    }),
    "counter_range",
  );
});
test("JSON Patch add/remove/replace applies to a copy", () => {
  const spec = laundry();
  const patched = applyPatch(spec, [
    { op: "replace", path: "/elements/washer/props/label", value: "Washer!" },
    { op: "add", path: "/elements/main/children/-", value: "note" },
    {
      op: "add",
      path: "/elements/note",
      value: { type: "Note", props: { stateKey: "n" } },
    },
    { op: "remove", path: "/elements/dryer/props/entity" },
  ]);
  assert(patched.ok);
  const value = patched.value as Mutable;
  assert.equal(value.elements.washer.props.label, "Washer!");
  assert.deepEqual(value.elements.main.children, ["grid", "fold", "note"]);
  assert.equal((spec as Mutable).elements.washer.props.label, "Washer");
});
test("JSON Patch rejects unsupported ops, missing targets and prototype paths", () => {
  for (const [op, code] of [
    [{ op: "move", from: "/a", path: "/b" }, /op, path, value/],
    [{ op: "copy", path: "/b", value: 1 }, /Unsupported op/],
    [
      { op: "replace", path: "/elements/none/type", value: "Text" },
      /does not exist/,
    ],
    [
      { op: "remove", path: "/elements/washer/props/missing" },
      /Nothing to remove/,
    ],
    [{ op: "add", path: "/__proto__/polluted", value: true }, /Forbidden/],
    [
      { op: "add", path: "/elements/main/children/9", value: "x" },
      /out of range/,
    ],
    [{ op: "replace", path: "elements", value: 1 }, /JSON Pointer/],
  ] as const) {
    const result = applyPatch(laundry(), [op]);
    assert(!result.ok);
    assert.equal(result.errors[0]!.path, "/patch/0");
    assert.match(result.errors[0]!.message, code);
  }
  assert.equal(({} as Mutable).polluted, undefined);
  assert(!applyPatch(laundry(), []).ok);
});
test("diff summarizes added/removed/changed elements and entity scope", () => {
  const before = validateSpec(laundry(), context);
  const after = mutate((s) => {
    delete s.elements.dryer;
    s.elements.grid.children = ["washer", "power"];
    s.elements.power = {
      type: "EntityValue",
      props: { entity: "light.hall" },
    };
    s.scope.entities = ["sensor.washer_state", "light.hall"];
  });
  assert(before.ok && after.ok);
  const diff = diffSpecs(before.spec, after.spec);
  assert.deepEqual(diff.added, ["power"]);
  assert.deepEqual(diff.removed, ["dryer"]);
  assert.deepEqual(diff.changed, ["grid"]);
  assert.deepEqual(diff.entitiesAdded, ["light.hall"]);
  assert.deepEqual(diff.entitiesRemoved, [
    "sensor.dryer_state",
    "sensor.washer_power",
  ]);
});
test("catalog_describe and the tool summary come from the validator's schema", () => {
  const catalog = describeCatalog();
  assert.deepEqual(
    catalog.components.map((c) => c.type),
    Object.keys(COMPONENTS),
  );
  for (const type of Object.keys(COMPONENTS))
    assert.match(catalogSummary(), new RegExp(`\\b${type}\\(`));
  assert(!catalog.components.some((c) => /Iframe|Html|Script/.test(c.type)));
  assert.equal(catalog.templates.length, 4);
});
test("built-in templates validate once their placeholder entities are allowed", () => {
  assert.deepEqual(
    TEMPLATES.map((t) => t.name),
    ["Bedtime lock-up", "Laundry", "3D print monitor", "Maintenance checklist"],
  );
  for (const template of TEMPLATES) {
    const readable = template.spec.scope.entities;
    const result = validateSpec(template.spec, {
      readable,
      services: context.services,
    });
    assert(result.ok, `${template.name}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.spec, template.spec as AppSpec);
    // Without read scope, every template is rejected rather than guessed.
    assert(!validateSpec(template.spec, { readable: [], services: [] }).ok);
  }
});
