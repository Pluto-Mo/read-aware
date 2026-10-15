import { expect, test } from "bun:test";
import { volumeStep } from "./useVolumeKeySteps";

test("the direction preference decides which volume key reads on", () => {
  expect(volumeStep("next", "down-forward")).toBe(1);
  expect(volumeStep("prev", "down-forward")).toBe(-1);
  expect(volumeStep("next", "up-forward")).toBe(-1);
  expect(volumeStep("prev", "up-forward")).toBe(1);
});
