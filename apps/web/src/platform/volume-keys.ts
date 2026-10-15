import { invoke } from "./ipc";
import { isAndroid, isTauri } from "./environment";

/**
 * Custom DOM event dispatched by the Android shell when a captured volume key
 * is pressed. `detail` names the key's default reading direction (volume down
 * = "next"). Keep the name in step with MainActivity.dispatchKeyEvent.
 */
export const VOLUME_STEP_EVENT = "ra-volume-step";

export type VolumeStepDirection = "next" | "prev";

export type VolumeKeyHandler = (direction: VolumeStepDirection) => void;

/**
 * Route Android's volume keys to the app (dispatched as VOLUME_STEP_EVENT)
 * instead of the system volume. No-op off Android — iOS offers no public API
 * for capturing the volume buttons.
 */
function setVolumeKeyCapture(captured: boolean): void {
  if (!isTauri() || !isAndroid()) return;
  void invoke("set_volume_key_capture", { captured }).catch(() => {
    // Older shell builds without the command — the keys keep changing the
    // volume, which is exactly the uncaptured behavior.
  });
}

/** Live claims, most recent last. Only the newest one receives presses. */
const claims: VolumeKeyHandler[] = [];

function onVolumeStep(event: Event) {
  const handler = claims.at(-1);
  if (handler) handler((event as CustomEvent<VolumeStepDirection>).detail === "prev" ? "prev" : "next");
}

/**
 * Take the volume keys for `handler` until the returned release is called.
 * The shell captures the keys while any claim is live, so media volume works
 * normally the moment the last one is released. Overlapping claims (a reader
 * mode taking over from page turning, say) are arbitrated here: presses reach
 * only the newest live claim, and releasing it hands them back to the next.
 */
export function claimVolumeKeys(handler: VolumeKeyHandler): () => void {
  const claim: VolumeKeyHandler = (direction) => handler(direction);
  claims.push(claim);
  if (claims.length === 1) {
    window.addEventListener(VOLUME_STEP_EVENT, onVolumeStep);
    setVolumeKeyCapture(true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims.splice(claims.indexOf(claim), 1);
    if (claims.length === 0) {
      window.removeEventListener(VOLUME_STEP_EVENT, onVolumeStep);
      setVolumeKeyCapture(false);
    }
  };
}
