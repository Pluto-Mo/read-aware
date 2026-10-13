import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query and re-render when it flips.
 *
 * Backed by `useSyncExternalStore`, so the value is read fresh on every
 * render commit and stays in sync with rotation / window resizes. Returns
 * `false` during SSR (no `matchMedia`).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Phone-width viewport: below Tailwind's `md` breakpoint (48rem), matching the
 * `max-md:` utility variant. Layouts branch on this to swap desktop docked
 * panels for full-screen sheets, show the bottom navigation bar, etc.
 */
export const PHONE_VIEWPORT_QUERY = "(max-width: 47.9375rem)";

/**
 * Compact chrome for a 7" e-ink panel. Leaf 5 is 1680×1264 at ~300dpi, so
 * landscape is about 896 CSS pixels — past the phone breakpoint, still too
 * narrow for desktop reader chrome. 60rem (960px) covers both orientations.
 * Only consulted when the document is marked `data-eink`.
 */
export const EINK_COMPACT_QUERY = "(max-width: 60rem)";

/** Keep in step with `isEinkDocument` in `apps/web/src/platform/eink.ts`. */
export function isEinkDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset.eink === "1";
}

/** Phone layout, or e-ink compact layout when the shell set `data-eink`. */
export function isCompactViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (window.matchMedia(PHONE_VIEWPORT_QUERY).matches) return true;
  return isEinkDocument() && window.matchMedia(EINK_COMPACT_QUERY).matches;
}

function subscribeCompactViewport(onChange: () => void): () => void {
  const phone = window.matchMedia(PHONE_VIEWPORT_QUERY);
  const eink = window.matchMedia(EINK_COMPACT_QUERY);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-eink"] });
  phone.addEventListener("change", onChange);
  eink.addEventListener("change", onChange);
  return () => {
    phone.removeEventListener("change", onChange);
    eink.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

/**
 * True on phone-width viewports, and on an e-ink panel whose CSS width is
 * still inside {@link EINK_COMPACT_QUERY}. Ordinary desktops and phones are
 * unchanged: `data-eink` is only set by the Onyx Android shell.
 */
export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribeCompactViewport, isCompactViewport, () => false);
}
