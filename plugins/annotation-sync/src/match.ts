/** Textual book and quote matching. Editions are not assumed to share an EPUB. */

export function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u3000/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen–Dice on character bigrams of the normalized strings. */
export function diceCoefficient(left: string, right: string): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const leftGrams = bigramCounts(a);
  const rightGrams = bigramCounts(b);
  let overlap = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (const count of leftGrams.values()) leftCount += count;
  for (const count of rightGrams.values()) rightCount += count;
  for (const [gram, count] of leftGrams) overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  return (2 * overlap) / (leftCount + rightCount);
}

export function titleVariants(title: string): string[] {
  const trimmed = title.trim().replace(/\s*\(z-library\)\s*$/i, "");
  const head = trimmed.split(/\s*[:：—–|]\s*/)[0]?.trim() ?? trimmed;
  return [...new Set([trimmed, head].filter((part) => part.length > 0))];
}

function containmentScore(left: string, right: string): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter < 4 || shorter / longer < 0.6) return 0;
  if (a.includes(b) || b.includes(a)) return shorter / longer;
  return 0;
}

export function titleScore(sourceTitle: string, localTitle: string): number {
  let best = 0;
  for (const source of titleVariants(sourceTitle)) {
    for (const local of titleVariants(localTitle)) {
      best = Math.max(best, diceCoefficient(source, local), containmentScore(source, local));
    }
  }
  return best;
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function hasLatin(value: string): boolean {
  return /\p{Script=Latin}/u.test(value);
}

/**
 * Authors veto a title match only when both are present in the same script and
 * dissimilar. A Chinese Weread author and a Latin edition credit do not veto;
 * the title still has to match on its own.
 */
export function authorConflicts(sourceAuthor: string, localAuthor: string | undefined): boolean {
  const source = sourceAuthor.trim();
  const local = localAuthor?.trim() ?? "";
  if (!source || !local) return false;
  const normalizedSource = normalizeMatchText(source);
  const normalizedLocal = normalizeMatchText(local);
  if (!normalizedSource || !normalizedLocal) return false;
  if (normalizedSource.includes(normalizedLocal) || normalizedLocal.includes(normalizedSource)) return false;
  const comparable =
    (hasHan(source) && hasHan(local)) || (hasLatin(source) && hasLatin(local) && !hasHan(source) && !hasHan(local));
  if (!comparable) return false;
  return diceCoefficient(source, local) < 0.34;
}

export type TitleCandidate<T extends { title: string; author?: string }> = {
  book: T;
  titleScore: number;
};

export function rankTitleMatches<T extends { title: string; author?: string }>(
  source: { title: string; author: string },
  books: T[],
): TitleCandidate<T>[] {
  return books
    .map((book) => ({ book, titleScore: titleScore(source.title, book.title) }))
    .filter((row) => row.titleScore >= 0.72 && !authorConflicts(source.author, row.book.author))
    .sort((left, right) => right.titleScore - left.titleScore);
}

/** Case-sensitive windows sent to the host search. Scoring uses the original quote. */
export function quoteWindows(quote: string): string[] {
  const compact = quote.replace(/\s+/g, " ").trim();
  if (compact.length < 4) return [];
  if (compact.length <= 80) return [compact];
  const size = 36;
  const middle = Math.max(0, Math.floor((compact.length - size) / 2));
  const windows = [compact.slice(middle, middle + size), compact.slice(0, size)];
  return [...new Set(windows.filter((window) => window.trim().length >= 4))].slice(0, 2);
}

export function quoteOverlap(quote: string, snippet: string): number {
  const left = normalizeMatchText(quote);
  const right = normalizeMatchText(snippet);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) || left.includes(right)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return shorter / longer;
  }
  return diceCoefficient(quote, snippet);
}

export function chapterOverlap(sourceChapter: string, localChapter: string): number {
  if (!sourceChapter.trim() || !localChapter.trim()) return 0;
  return Math.max(diceCoefficient(sourceChapter, localChapter), containmentScore(sourceChapter, localChapter));
}
