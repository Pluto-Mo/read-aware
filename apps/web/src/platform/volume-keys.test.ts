import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { claimVolumeKeys, VOLUME_STEP_EVENT, type VolumeStepDirection } from "./volume-keys";

let dom: JSDOM;
const previous = new Map<string, PropertyDescriptor | undefined>();
let captures: boolean[];
const releases: (() => void)[] = [];

function setGlobal(name: string, value: unknown) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  dom = new JSDOM("", { url: "http://localhost" });
  setGlobal("window", dom.window);
  setGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36" });
  captures = [];
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { captured: boolean }) => {
        if (command === "set_volume_key_capture") captures.push(args.captured);
      },
    },
  });
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  dom.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  previous.clear();
});

const press = (detail: VolumeStepDirection) =>
  dom.window.dispatchEvent(new dom.window.CustomEvent(VOLUME_STEP_EVENT, { detail }));
const claim = (handler: (direction: VolumeStepDirection) => void) => {
  const release = claimVolumeKeys(handler);
  releases.push(release);
  return release;
};

test("the shell captures the keys exactly while some claim is live", () => {
  const first = claim(() => {});
  const second = claim(() => {});
  expect(captures).toEqual([true]);
  first();
  expect(captures).toEqual([true]);
  second();
  expect(captures).toEqual([true, false]);
  // Releasing twice is harmless and never re-toggles the shell.
  second();
  expect(captures).toEqual([true, false]);
});

test("presses reach only the newest claim, and fall back when it is released", () => {
  const pageTurns: VolumeStepDirection[] = [];
  const unitSteps: VolumeStepDirection[] = [];
  claim((direction) => pageTurns.push(direction));
  const releaseUnits = claim((direction) => unitSteps.push(direction));
  press("next");
  press("prev");
  expect(unitSteps).toEqual(["next", "prev"]);
  expect(pageTurns).toEqual([]);
  releaseUnits();
  press("next");
  expect(pageTurns).toEqual(["next"]);
  expect(unitSteps).toEqual(["next", "prev"]);
});

test("presses after the last release go nowhere", () => {
  const seen: VolumeStepDirection[] = [];
  claim((direction) => seen.push(direction))();
  press("next");
  expect(seen).toEqual([]);
});
