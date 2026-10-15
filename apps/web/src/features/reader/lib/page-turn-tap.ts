import {
  TAP_ZONE_WIDTH_RATIO,
  type PageTurnTapZoneWidth,
  type PageTurnTapZones,
} from "../../../domain/settings/page-turn-settings";

/** A tap that turns the page. */
export type PageTurnTap = {
  /** Reading direction: 1 reads on, -1 goes back. */
  step: -1 | 1;
  /** Screen side the turn moves toward (1 = right), for panning a zoomed
   *  fixed-layout page before it turns — the same order the arrow keys use. */
  side: -1 | 1;
};

/**
 * What a content tap at `x` (reader-root coordinates, `width` wide) does
 * under the tap-zone preference: a page turn, or null for the center band,
 * which toggles the reader chrome as every tap does with zones off.
 *
 * Zones are physical. With `sides`, the zone toward the next page reads on,
 * so in a right-to-left book the left zone advances; with `forward`, both
 * zones read on and pan toward the next page.
 */
export function resolvePageTurnTap(input: {
  x: number;
  width: number;
  zones: PageTurnTapZones;
  zoneWidth: PageTurnTapZoneWidth;
  rtl: boolean;
}): PageTurnTap | null {
  const { x, width, zones, zoneWidth, rtl } = input;
  if (zones === "off" || !(width > 0)) return null;
  const edge = width * TAP_ZONE_WIDTH_RATIO[zoneWidth];
  const side: -1 | 1 | null = x < edge ? -1 : x > width - edge ? 1 : null;
  if (side === null) return null;
  const nextSide: -1 | 1 = rtl ? -1 : 1;
  if (zones === "forward") return { step: 1, side: nextSide };
  return { step: side === nextSide ? 1 : -1, side };
}
