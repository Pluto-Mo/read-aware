import { beforeEach, expect, test } from "bun:test";
import { getDefaultStore } from "jotai";
import { pageTurnSettingsAtom, readerOverridesAtom, readerPreferencesAtom } from "../../state/ui";
import {
  DEFAULT_PAGE_TURN_SETTINGS,
  PAGE_TURN_SETTINGS_KEY,
  getPageTurnSettings,
  type PageTurnSettings,
} from "./page-turn-settings";
import { READER_OVERRIDES_KEY } from "../../features/settings/lib/reader-overrides";
import { DEFAULT_READER_PREFERENCES } from "../../features/settings/lib/reader-settings";
import { localKV } from "../../platform/local-store";
import { createSettingsDomain } from "./domain";
import { installFileGlobals, memoryStorage } from "../../../tests/helpers/file-globals";

const disk = new Map<string, string>();
installFileGlobals({ localStorage: memoryStorage(disk) });
const store = getDefaultStore();
const PATHS = [
  "reading.pageTurn.tapZones",
  "reading.pageTurn.tapZoneWidth",
  "reading.pageTurn.volumeKeys",
  "reading.pageTurn.volumeKeyDirection",
];

beforeEach(async () => {
  await localKV.setItemAsync(PAGE_TURN_SETTINGS_KEY, JSON.stringify(DEFAULT_PAGE_TURN_SETTINGS));
  await localKV.setItemAsync(READER_OVERRIDES_KEY, JSON.stringify({}));
});

test("the Agent discovers page-turn paths as global-only reading settings", async () => {
  const snapshot = await createSettingsDomain("agent").queries.snapshot({ section: "reading" });
  const pageTurn = snapshot.settings.filter((setting) => setting.path.startsWith("reading.pageTurn."));
  expect(
    pageTurn.map((setting) => [
      setting.path,
      setting.value,
      setting.options?.map((option) => option.value),
      setting.supportedTargets,
    ]),
  ).toEqual([
    ["reading.pageTurn.tapZones", "off", ["off", "sides", "forward"], ["global"]],
    ["reading.pageTurn.tapZoneWidth", "medium", ["narrow", "medium", "wide"], ["global"]],
    ["reading.pageTurn.volumeKeys", false, undefined, ["global"]],
    ["reading.pageTurn.volumeKeyDirection", "down-forward", ["down-forward", "up-forward"], ["global"]],
  ]);
  // Device-local input is not book-scoped, so it carries no book-override metadata.
  for (const setting of pageTurn) expect(setting.reading).toBeUndefined();
});

test("an Agent update persists every path and reaches the live atom", async () => {
  await createSettingsDomain("agent").commands.update([
    { path: "reading.pageTurn.tapZones", value: "forward" },
    { path: "reading.pageTurn.tapZoneWidth", value: "wide" },
    { path: "reading.pageTurn.volumeKeys", value: true },
    { path: "reading.pageTurn.volumeKeyDirection", value: "up-forward" },
  ]);
  const expected: PageTurnSettings = {
    tapZones: "forward",
    tapZoneWidth: "wide",
    volumeKeys: true,
    volumeKeyDirection: "up-forward",
  };
  expect(store.get(pageTurnSettingsAtom)).toEqual(expected);
  expect(getPageTurnSettings()).toEqual(expected);
  expect(JSON.parse(disk.get(PAGE_TURN_SETTINGS_KEY)!)).toEqual(expected);
  // Page turning never leaks into the per-book reader preference record.
  expect(store.get(readerPreferencesAtom)).not.toHaveProperty("tapZones");
});

test("invalid values, book targets and ungranted plugins leave the settings unchanged", async () => {
  const agent = createSettingsDomain("agent");
  await expect(
    agent.commands.update([
      { path: "reading.pageTurn.tapZones", value: "sides" },
      { path: "reading.pageTurn.tapZoneWidth", value: "enormous" },
    ]),
  ).rejects.toThrow();
  await expect(agent.commands.update([{ path: "reading.pageTurn.volumeKeys", value: "yes" }])).rejects.toThrow();
  await expect(
    agent.commands.update([
      { path: "reading.pageTurn.tapZones", value: "sides", target: { kind: "book", bookId: "one" } },
    ]),
  ).rejects.toThrow();
  await expect(
    agent.commands.update([{ path: "reading.pageTurn.tapZones", value: "sides", target: { kind: "all-books" } }]),
  ).rejects.toThrow();
  await expect(
    createSettingsDomain("plugin:none").commands.update([{ path: "reading.pageTurn.tapZones", value: "sides" }]),
  ).rejects.toThrow();
  expect(store.get(pageTurnSettingsAtom)).toEqual(DEFAULT_PAGE_TURN_SETTINGS);
});

test("a granted plugin can change page turning through the same catalog", async () => {
  await createSettingsDomain("plugin:input", { write: ["reading.pageTurn.*"] }).commands.update([
    { path: "reading.pageTurn.tapZones", value: "sides" },
  ]);
  expect(store.get(pageTurnSettingsAtom).tapZones).toBe("sides");
});

test("book overrides never claim to shadow page-turn paths", async () => {
  store.set(readerOverridesAtom, { book: { scope: "book", settings: { ...DEFAULT_READER_PREFERENCES } } });
  const snapshot = await createSettingsDomain("agent").queries.snapshot({ section: "reading" });
  const shadowed = snapshot.overrides.flatMap((override) => override.paths);
  expect(shadowed).toContain("reading.fontSize");
  for (const path of PATHS) expect(shadowed).not.toContain(path);
});

test("a reading reset keeps page-turn preferences", async () => {
  const agent = createSettingsDomain("agent");
  await agent.commands.update([{ path: "reading.pageTurn.volumeKeys", value: true }]);
  await agent.commands.resetReading({ action: "defaults", target: { kind: "global" } });
  expect(store.get(pageTurnSettingsAtom).volumeKeys).toBe(true);
});

test("external persisted writes refresh the atom, and corrupt records read as defaults", async () => {
  await localKV.setItemAsync(PAGE_TURN_SETTINGS_KEY, JSON.stringify({ tapZones: "sides", volumeKeys: true }));
  expect(store.get(pageTurnSettingsAtom)).toEqual({
    ...DEFAULT_PAGE_TURN_SETTINGS,
    tapZones: "sides",
    volumeKeys: true,
  });
  await localKV.setItemAsync(PAGE_TURN_SETTINGS_KEY, JSON.stringify({ tapZones: "everywhere", volumeKeys: 1 }));
  expect(store.get(pageTurnSettingsAtom)).toEqual(DEFAULT_PAGE_TURN_SETTINGS);
});
