/**
 * True when the Android shell has marked this document as an Onyx e-ink
 * panel (`html[data-eink="1"]`). Absent on every other platform, including
 * ordinary Android phones. Keep the attribute name in step with
 * `isEinkDocument` in `@read-aware/ui/media`.
 */
export function isEinkDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset.eink === "1";
}
