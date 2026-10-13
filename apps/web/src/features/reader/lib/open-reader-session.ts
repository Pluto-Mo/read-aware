/** Last relocate, kept because a killed activity never flushes the reading session. */
export const OPEN_READER_POSITION_KEY = "read-aware-open-reader-position";

export type OpenReaderPosition = {
  cfi: string | null;
  href: string | null;
  progressPercent: number;
  currentLocation: number;
  totalLocations: number;
};

export function rememberOpenReaderPosition(bookId: string, progress: OpenReaderPosition): void {
  try {
    localStorage.setItem(
      OPEN_READER_POSITION_KEY,
      JSON.stringify({
        bookId,
        cfi: progress.cfi,
        href: progress.href,
        progressPercent: progress.progressPercent,
        currentLocation: progress.currentLocation,
        totalLocations: progress.totalLocations,
      }),
    );
  } catch {
    // The projection still has the last flushed session.
  }
}

export function forgetOpenReaderPosition(): void {
  try {
    localStorage.removeItem(OPEN_READER_POSITION_KEY);
  } catch {
    // The key is already gone.
  }
}

/** Snapshot written for this book, or null when it is missing or for another book. */
export function parseOpenReaderPosition(raw: string | null, bookId: string): OpenReaderPosition | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      bookId?: unknown;
      cfi?: unknown;
      href?: unknown;
      progressPercent?: unknown;
      currentLocation?: unknown;
      totalLocations?: unknown;
    };
    if (parsed.bookId !== bookId || typeof parsed.progressPercent !== "number") return null;
    return {
      cfi: typeof parsed.cfi === "string" ? parsed.cfi : null,
      href: typeof parsed.href === "string" ? parsed.href : null,
      progressPercent: parsed.progressPercent,
      currentLocation: typeof parsed.currentLocation === "number" ? parsed.currentLocation : 0,
      totalLocations: typeof parsed.totalLocations === "number" ? parsed.totalLocations : 0,
    };
  } catch {
    return null;
  }
}

export function readOpenReaderPosition(bookId: string): OpenReaderPosition | null {
  try {
    return parseOpenReaderPosition(localStorage.getItem(OPEN_READER_POSITION_KEY), bookId);
  } catch {
    return null;
  }
}

/** Crash snapshot wins over the last flushed projection. A clean close clears the snapshot. */
export function positionForOpen(
  bookId: string,
  persisted: OpenReaderPosition | null,
  rawSnapshot: string | null,
): OpenReaderPosition | null {
  return parseOpenReaderPosition(rawSnapshot, bookId) ?? persisted;
}
