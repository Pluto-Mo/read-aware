import { localKV } from "../../platform/local-store";

export const PAGE_TURN_SETTINGS_KEY = "read-aware-page-turn";

/**
 * What a tap on the page's side zones does. The center band always toggles
 * the reader chrome.
 * - `off`: no zones — every tap toggles the chrome (the default; a stray tap
 *   never costs the reader their place).
 * - `sides`: the left zone turns back and the right zone forward (mirrored in
 *   right-to-left books, so the zone toward the next page always advances).
 * - `forward`: both zones turn forward, for one-handed reading.
 */
export type PageTurnTapZones = "off" | "sides" | "forward";

/** How much of the reader's width each side zone covers. */
export type PageTurnTapZoneWidth = "narrow" | "medium" | "wide";

/** Which volume key reads on. The other one steps back. */
export type VolumeKeyDirection = "down-forward" | "up-forward";

/** How taps and hardware keys turn pages. Persisted, device-local. */
export type PageTurnSettings = {
  tapZones: PageTurnTapZones;
  tapZoneWidth: PageTurnTapZoneWidth;
  /** Android only: the volume keys turn pages while a book is open. */
  volumeKeys: boolean;
  /** Applies wherever the volume keys navigate, sentence stepping included. */
  volumeKeyDirection: VolumeKeyDirection;
};

export const PAGE_TURN_TAP_ZONES: readonly PageTurnTapZones[] = ["off", "sides", "forward"];
export const PAGE_TURN_TAP_ZONE_WIDTHS: readonly PageTurnTapZoneWidth[] = ["narrow", "medium", "wide"];
export const VOLUME_KEY_DIRECTIONS: readonly VolumeKeyDirection[] = ["down-forward", "up-forward"];

export const DEFAULT_PAGE_TURN_SETTINGS: PageTurnSettings = {
  tapZones: "off",
  tapZoneWidth: "medium",
  volumeKeys: false,
  volumeKeyDirection: "down-forward",
};

/** Fraction of the reader's width each side zone covers. */
export const TAP_ZONE_WIDTH_RATIO: Record<PageTurnTapZoneWidth, number> = {
  narrow: 0.2,
  medium: 0.3,
  wide: 0.4,
};

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizePageTurnSettings(raw: unknown): PageTurnSettings {
  const stored = raw && typeof raw === "object" ? (raw as Partial<Record<keyof PageTurnSettings, unknown>>) : {};
  const defaults = DEFAULT_PAGE_TURN_SETTINGS;
  return {
    tapZones: pick(PAGE_TURN_TAP_ZONES, stored.tapZones, defaults.tapZones),
    tapZoneWidth: pick(PAGE_TURN_TAP_ZONE_WIDTHS, stored.tapZoneWidth, defaults.tapZoneWidth),
    volumeKeys: typeof stored.volumeKeys === "boolean" ? stored.volumeKeys : defaults.volumeKeys,
    volumeKeyDirection: pick(VOLUME_KEY_DIRECTIONS, stored.volumeKeyDirection, defaults.volumeKeyDirection),
  };
}

export function getPageTurnSettings(): PageTurnSettings {
  try {
    const raw = localKV.getItem(PAGE_TURN_SETTINGS_KEY);
    return raw ? normalizePageTurnSettings(JSON.parse(raw)) : DEFAULT_PAGE_TURN_SETTINGS;
  } catch {
    // A corrupt record reads as the defaults; the next save replaces it.
    return DEFAULT_PAGE_TURN_SETTINGS;
  }
}

export function savePageTurnSettings(settings: PageTurnSettings): void {
  localKV.setItem(PAGE_TURN_SETTINGS_KEY, JSON.stringify(settings));
}
