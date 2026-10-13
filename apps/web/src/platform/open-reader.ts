/** Device-local. Set while a book is on screen so an activity restart can reopen it. */
export const OPEN_READER_KEY = "read-aware-open-reader";

export function rememberOpenReader(bookId: string): void {
  try {
    localStorage.setItem(OPEN_READER_KEY, bookId);
  } catch {
    // Private mode or a full store: the next launch stays on the shelf.
  }
}

export function forgetOpenReader(): void {
  try {
    localStorage.removeItem(OPEN_READER_KEY);
  } catch {
    // The key is already gone.
  }
}

export function rememberedOpenReader(): string | null {
  try {
    const value = localStorage.getItem(OPEN_READER_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
