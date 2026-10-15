import { useEffect, useRef } from "react";
import { forgetOpenReader, rememberedOpenReader } from "../../../platform/open-reader";
import type { StartView } from "../../settings/lib/general-settings";
import type { LibraryBook } from "../lib/library-types";

/** Consume the launch preference once, after local books and their providers load. */
export function useStartupBook({
  startView,
  ready,
  idle,
  books,
  openBook,
  reportError,
}: {
  startView: StartView;
  ready: boolean;
  idle: boolean;
  books: LibraryBook[];
  openBook(book: LibraryBook): void;
  reportError(error: unknown): void;
}) {
  const preference = useRef(startView);
  const consumed = useRef(false);
  // Read once. An Onyx density/engine restart kills the webview; the book that
  // was on screen is more specific than the shelf's resume preference.
  const pinnedBookId = useRef<string | null | undefined>(undefined);
  if (pinnedBookId.current === undefined) pinnedBookId.current = rememberedOpenReader();
  useEffect(() => {
    if (consumed.current) return;
    const pin = pinnedBookId.current;
    if (pin) {
      if (!ready || !idle) return;
      consumed.current = true;
      const book = books.find((item) => item.id === pin);
      if (!book) {
        forgetOpenReader();
        return;
      }
      try {
        openBook(book);
      } catch (error) {
        reportError(error);
      }
      return;
    }
    if (!idle || preference.current !== "resume") {
      consumed.current = true;
      return;
    }
    // A delayed plugin startup must not move the user away from work begun since launch.
    const cancel = () => {
      consumed.current = true;
    };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    if (ready) {
      consumed.current = true;
      let latest: LibraryBook | undefined,
        timestamp = -Infinity;
      for (const book of books) {
        const opened = book.lastOpenedAt ? Date.parse(book.lastOpenedAt) : NaN;
        if (Number.isFinite(opened) && opened > timestamp) {
          latest = book;
          timestamp = opened;
        }
      }
      // Never substitute a newly imported/edited book for the last book actually opened.
      if (latest) {
        try {
          openBook(latest);
        } catch (error) {
          reportError(error);
        }
      }
    }
    return () => {
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [ready, idle, books, openBook, reportError]);
}
