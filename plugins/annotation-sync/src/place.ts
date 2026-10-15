import { chapterOverlap, quoteOverlap, quoteWindows, rankTitleMatches } from "./match";
import {
  QUOTE_SEARCH_BUDGET,
  groupId,
  type IncomingExcerpt,
  type LocalBookRef,
  type QuoteSearcher,
  type StoredExcerpt,
  type StoredSourceBook,
} from "./types";

export type PlacementResult = {
  excerpts: StoredExcerpt[];
  source: StoredSourceBook;
  quoteSearches: number;
  quoteSearchTruncated: boolean;
};

export async function placeExcerpts(input: {
  source: "weread" | "neoreader";
  sourceBookId: string;
  title: string;
  author: string;
  bookmarkCount: number | null;
  excerpts: IncomingExcerpt[];
  books: LocalBookRef[];
  forcedBookId?: string | null;
  search: QuoteSearcher;
  now?: string;
  quoteBudget?: number;
}): Promise<PlacementResult> {
  const group = groupId(input.source, input.sourceBookId);
  const forced = input.forcedBookId ? input.books.find((book) => book.id === input.forcedBookId) : undefined;
  const ranked = forced
    ? [{ book: forced, titleScore: 1 }]
    : rankTitleMatches({ title: input.title, author: input.author }, input.books).slice(0, 3);
  const primary = ranked[0];
  let remaining = input.quoteBudget ?? QUOTE_SEARCH_BUDGET;
  let quoteSearches = 0;
  let quoteSearchTruncated = false;
  const placed: StoredExcerpt[] = [];

  for (const excerpt of input.excerpts) {
    const windows = excerpt.quote ? quoteWindows(excerpt.quote) : [];
    let best: {
      book: LocalBookRef;
      titleScore: number;
      quoteScore: number;
      chapterScore: number;
      chapterTitle: string;
    } | null = null;
    if (windows.length > 0 && ranked.length > 0 && remaining <= 0) quoteSearchTruncated = true;
    const canSearch = windows.length > 0 && remaining > 0 && ranked.length > 0;
    if (canSearch) {
      for (const candidate of ranked) {
        if (remaining <= 0) break;
        remaining -= 1;
        quoteSearches += 1;
        const hits = await input.search(candidate.book.id, windows);
        if (hits === "unavailable" || hits.length === 0) continue;
        for (const hit of hits) {
          const overlap = quoteOverlap(excerpt.quote, hit.snippet);
          const quoteScore = hit.exact ? Math.max(overlap, 0.75) : overlap;
          if (quoteScore < 0.55) continue;
          const chapterScore = chapterOverlap(excerpt.sourceChapter, hit.chapterTitle);
          const score = quoteScore + chapterScore * 0.15;
          const current = best ? best.quoteScore + best.chapterScore * 0.15 : -1;
          if (score > current) {
            best = {
              book: candidate.book,
              titleScore: candidate.titleScore,
              quoteScore,
              chapterScore,
              chapterTitle: hit.chapterTitle,
            };
          }
        }
        if (best && best.quoteScore >= 0.8) break;
      }
    }
    const linked = best?.book ?? primary?.book ?? null;
    placed.push({
      id: excerpt.id,
      source: excerpt.source,
      sourceBookId: input.sourceBookId,
      group,
      kind: excerpt.kind,
      quote: excerpt.quote,
      note: excerpt.note,
      sourceTitle: input.title,
      sourceAuthor: input.author,
      sourceChapter: excerpt.sourceChapter,
      pageLabel: excerpt.pageLabel,
      createdAt: excerpt.createdAt,
      localBookId: linked?.id ?? null,
      localTitle: linked?.title ?? null,
      anchor: best ? "anchored" : "unanchored",
      titleScore: best?.titleScore ?? primary?.titleScore ?? 0,
      quoteScore: best?.quoteScore ?? 0,
      chapterScore: best?.chapterScore ?? 0,
    });
  }

  const anchored = placed.filter((excerpt) => excerpt.anchor === "anchored").length;
  return {
    excerpts: placed,
    quoteSearches,
    quoteSearchTruncated,
    source: {
      source: input.source,
      sourceBookId: input.sourceBookId,
      group,
      title: input.title,
      author: input.author,
      highlightCount: placed.filter((excerpt) => excerpt.kind === "highlight").length,
      thoughtCount: placed.filter((excerpt) => excerpt.kind === "thought").length,
      bookmarkCount: input.bookmarkCount,
      localBookId: primary?.book.id ?? null,
      localTitle: primary?.book.title ?? null,
      anchored,
      unanchored: placed.length - anchored,
      syncedAt: input.now ?? new Date().toISOString(),
    },
  };
}
