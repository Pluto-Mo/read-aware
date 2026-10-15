import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { HOST_COMMAND_IDS } from "../packages/core/src/host-commands";
import { assertUniqueSourceKeys, collectInventory } from "./host-capability-inventory";

test("inventory evidence stays identical across filesystem enumeration orders", () => {
  const expected = structuredClone(collectInventory());
  // Keep the filesystem mock in its own process so sibling suites retain real IO.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import fs from "node:fs";
    import { mock } from "bun:test";
    const readDirectory = fs.readdirSync;
    let reordered = 0;
    mock.module("node:fs", () => ({ ...fs, readdirSync: (...args) => {
      const entries = readDirectory(...args);
      reordered++;
      return entries.reverse();
    }}));
    const { collectInventory } = await import("./scripts/host-capability-inventory.ts");
    const inventory = collectInventory();
    console.log(JSON.stringify({ inventory, reordered }));
    process.exit(0);
  `,
    ],
    { cwd: resolve(import.meta.dir, ".."), timeout: 20_000 },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const actual = JSON.parse(child.stdout.toString());
  expect(actual.reordered).toBeGreaterThan(1);
  expect(actual.inventory).toEqual(expected);
}, 30_000);

test("source evidence keys cannot silently overwrite an unrelated capability source", () => {
  expect(() => assertUniqueSourceKeys()).not.toThrow();
  expect(() => assertUniqueSourceKeys('const sources = { MEMORYPOLICY: "one", "MEMORYPOLICY": "two" };')).toThrow(
    "Duplicate source key: MEMORYPOLICY",
  );
  expect(() => assertUniqueSourceKeys("const sources = { ...other };")).toThrow("Expected static source key");
});

test("import task controls have explicit actor mappings and are absent from book-scoped Agent tools", () => {
  const inventory = collectInventory();
  for (const name of ["query_book_imports", "manage_book_import"]) {
    expect(inventory.find((item) => item.family === "Agent global" && item.name.endsWith(name))?.rows).toEqual(
      expect.arrayContaining(["LIB06", "CON06"]),
    );
    expect(inventory.some((item) => item.family === "Agent book" && item.name.endsWith(name))).toBe(false);
  }
  for (const name of [
    "domains.library.commands.books.startImport",
    "domains.library.commands.books.cancelImportTask",
    "domains.library.queries.books.getImportTask",
    "domains.library.queries.books.listImportTasks",
    "domains.library.events.observeImportTask",
  ]) {
    expect(inventory.find((item) => item.family === "Plugin ctx" && item.name === name)?.rows).toEqual([
      "LIB06",
      "CON06",
    ]);
  }
});

test("Jumper bookmark tools are inventoried as global plugin extensions, not new host APIs", () => {
  const tools = collectInventory().filter(
    (item) => item.family === "Plugin Agent contribution" && item.name.startsWith("plugin_jumper_"),
  );
  expect(tools.map((item) => item.name)).toEqual([
    "plugin_jumper_list_bookmarks",
    "plugin_jumper_inspect_bookmark_location",
    "plugin_jumper_save_bookmark",
    "plugin_jumper_manage_bookmark",
  ]);
  expect(tools.every((item) => item.rows.includes("SYS02") && item.note.includes("仅 global"))).toBe(true);
});

test("semantic commands retain explicit audit mappings after native callback removal", () => {
  const inventory = collectInventory();
  const commands = inventory.filter((item) => item.family === "Host semantic command");
  expect(commands.map((item) => item.name)).toEqual([...HOST_COMMAND_IDS]);
  expect(commands).toHaveLength(18);
  expect(commands.every((item) => item.rows.includes("UI03"))).toBe(true);
  expect(commands.find((item) => item.name === "open-book")!.rows).toContain("READ01");
  expect(inventory.filter((item) => item.family === "Command action").map((item) => item.name)).toEqual([
    "importBook",
    "importFolder",
  ]);
});

test("a new semantic command cannot silently inherit a catch-all audit mapping", () => {
  const ids = HOST_COMMAND_IDS as unknown as string[];
  ids.push("audit-unmapped-command");
  try {
    expect(() => collectInventory()).toThrow("Unmapped Host semantic command: audit-unmapped-command");
  } finally {
    ids.pop();
  }
});

test("annotation edits and removals have one conditional public inventory entry", () => {
  const commands = collectInventory().filter(
    (item) => item.family === "Plugin ctx" && item.name.startsWith("domains.annotations.commands."),
  );
  expect(commands.map((item) => item.name).sort()).toEqual([
    "domains.annotations.commands.applyChanges",
    "domains.annotations.commands.createHighlight",
    "domains.annotations.commands.createNote",
  ]);
  expect(commands.find((item) => item.name.endsWith("applyChanges"))!.rows).toEqual([
    "ANN04",
    "ANN05",
    "ANN06",
    "ANN08",
  ]);
});

test("profile transaction commands are native foundations, not new public actor entrypoints", () => {
  const native = collectInventory().filter(
    (item) => item.family === "Native command" && item.name.startsWith("storage::profile_"),
  );
  expect(native.map((item) => item.name).sort()).toEqual([
    "storage::profile_commit",
    "storage::profile_context",
    "storage::profile_initialize",
    "storage::profile_inspect",
  ]);
  expect(native.find((item) => item.name === "storage::profile_context")?.rows).toEqual(["MEM06", "MEM08"]);
  expect(native.every((item) => item.rows.includes("MEM08"))).toBe(true);
});

test("identity consolidation foundations are mapped without inventing public actor tools", () => {
  const entries = collectInventory().filter((item) => item.name.includes("identity_consolidation"));
  expect(entries.map((item) => item.name).sort()).toEqual([
    "storage::identity_consolidation_commit",
    "storage::identity_consolidation_snapshot",
  ]);
  expect(
    entries.every((item) => item.family === "Native command" && item.rows.length === 1 && item.rows[0] === "MEM08"),
  ).toBe(true);
});

test("bundle publication is an event projection foundation, not a public export entrypoint", () => {
  const entries = collectInventory().filter((item) => item.name === "context.bundlePublished");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ family: "Canonical event", rows: ["MEM13"] });
  const native = collectInventory().filter((item) => item.name.startsWith("storage::context_bundle_"));
  expect(native.map((item) => item.name).sort()).toEqual([
    "storage::context_bundle_history",
    "storage::context_bundle_publish",
    "storage::context_bundle_read",
    "storage::context_bundle_source_revision",
  ]);
  expect(
    native.every((item) => item.family === "Native command" && item.rows.length === 1 && item.rows[0] === "MEM13"),
  ).toBe(true);
  expect(collectInventory().find((item) => item.name === "storage::conversation_insights_snapshot")).toMatchObject({
    family: "Native command",
    rows: ["MEM13"],
  });
  expect(collectInventory().find((item) => item.name === "storage::book_context_snapshot")).toMatchObject({
    family: "Native command",
    rows: ["MEM13"],
  });
});

test("durable private source reads are explicit inventory entries, not raw global KV for actors", () => {
  const inventory = collectInventory();
  expect(inventory.find((item) => item.name === "services.storage.getDurable")?.rows).toEqual(["SYS01", "MEM13"]);
  expect(inventory.find((item) => item.name === "storage::get_kv")?.rows).toEqual(["SYS01", "MEM13"]);
});

test("reading actions use one global entry while book agents answer directly", () => {
  const inventory = collectInventory();
  expect(inventory.find((item) => item.family === "Agent global" && item.name === "reading_action")?.rows).toEqual([
    "SET18",
    "SET19",
    "SET20",
    "SET21",
  ]);
  expect(inventory.some((item) => item.family === "Agent book" && item.name === "reading_action")).toBe(false);
  expect(inventory.some((item) => item.family === "Agent book" && item.name === "get_reading_session")).toBe(true);
});

test("entity registry native, Agent and plugin entrypoints have explicit MEM08 mappings", () => {
  const inventory = collectInventory();
  const native = inventory.filter(
    (item) => item.family === "Native command" && item.name.startsWith("storage::entity_"),
  );
  expect(native.map((item) => item.name).sort()).toEqual(["storage::entity_commit", "storage::entity_query"]);
  expect(native.every((item) => item.rows.length === 1 && item.rows[0] === "MEM08")).toBe(true);
  for (const name of [
    "domains.memory.queries.entities",
    "domains.memory.queries.profileContext",
    "domains.memory.commands.decideEntity",
  ]) {
    expect(inventory.find((item) => item.family === "Plugin ctx" && item.name === name)?.rows).toEqual(["MEM08"]);
  }
  for (const family of ["Agent global", "Agent book"])
    for (const name of ["query_entities", "manage_entity", "inspect_user_profile"]) {
      expect(inventory.find((item) => item.family === family && item.name === name)?.rows).toEqual(["MEM08"]);
    }
});

test("memory query and consumer inventories stay distinct from bundled or model tools", () => {
  const inventory = collectInventory();
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.queries.search")?.rows,
  ).toEqual(["MEM01"]);
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.queries.bookGraph")?.rows,
  ).toEqual(["MEM11"]);
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.queries.inspect")?.rows,
  ).toEqual(["MEM01", "MEM05"]);
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.commands.mutate")?.rows,
  ).toEqual(["MEM04", "MEM05"]);
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.events.observe")?.rows,
  ).toEqual(["MEM01", "MEM04", "MEM05", "MEM06", "MEM08", "MEM09", "MEM10", "MEM11"]);
  for (const name of [
    "domains.memory.queries.getGraphTask",
    "domains.memory.queries.listGraphTasks",
    "domains.memory.commands.startGraphTask",
    "domains.memory.commands.cancelGraphTask",
    "domains.memory.commands.retryGraphTask",
  ]) {
    expect(inventory.find((item) => item.family === "Plugin ctx" && item.name === name)?.rows).toEqual(["MEM10"]);
  }
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.queries.classification")
      ?.rows,
  ).toEqual(["MEM09"]);
  expect(
    inventory.find((item) => item.family === "Plugin ctx" && item.name === "domains.memory.commands.classify")?.rows,
  ).toEqual(["MEM09"]);
});
