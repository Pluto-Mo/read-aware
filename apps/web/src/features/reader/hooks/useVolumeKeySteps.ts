import { useEffect, useEffectEvent } from "react";
import { useAtomValue } from "jotai";
import { isEditableKeyTarget } from "../../../platform/app-keydown";
import { claimVolumeKeys, type VolumeStepDirection } from "../../../platform/volume-keys";
import { pageTurnSettingsAtom } from "../../../state/ui";
import type { VolumeKeyDirection } from "../../../domain/settings/page-turn-settings";

/** A press's reading direction under the user's volume-key preference. */
export function volumeStep(direction: VolumeStepDirection, preference: VolumeKeyDirection): -1 | 1 {
  const forward = direction === "next";
  return forward === (preference === "down-forward") ? 1 : -1;
}

/**
 * Android: while `enabled`, the volume keys call `onStep` (1 = read on,
 * -1 = back, per the volume-key direction preference) instead of changing
 * the volume. Off Android the claim is a no-op.
 *
 * The shell consumes captured presses before the page sees them, so the keys
 * are handed back while a note editor or chat composer has focus — otherwise
 * typing leaves the volume buttons dead: no step and no volume.
 */
export function useVolumeKeySteps(enabled: boolean, onStep: (step: -1 | 1) => void): void {
  const { volumeKeyDirection } = useAtomValue(pageTurnSettingsAtom);
  const handlePress = useEffectEvent((direction: VolumeStepDirection) => {
    // A press that raced the focus change still must not type over the field.
    if (isEditableKeyTarget(document.activeElement)) return;
    onStep(volumeStep(direction, volumeKeyDirection));
  });

  useEffect(() => {
    if (!enabled) return;
    let release: (() => void) | null = null;
    const syncClaim = () => {
      const wanted = !isEditableKeyTarget(document.activeElement);
      if (wanted && !release) release = claimVolumeKeys((direction) => handlePress(direction));
      else if (!wanted && release) {
        release();
        release = null;
      }
    };
    syncClaim();
    document.addEventListener("focusin", syncClaim);
    document.addEventListener("focusout", syncClaim);
    return () => {
      document.removeEventListener("focusin", syncClaim);
      document.removeEventListener("focusout", syncClaim);
      release?.();
    };
  }, [enabled]);
}
