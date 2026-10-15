import { parseAnnotationExport } from "./neoreader";
import { placeExcerpts, type PlacementResult } from "./place";
import { listDocuments, readLinks, refreshStatus, replaceGroup } from "./store";
import {
  EXCERPT_COLLECTION,
  SOURCE_COLLECTION,
  groupId,
  type AnnotationSyncContext,
  type LocalBookRef,
  type QuoteHit,
  type QuoteSearcher,
  type StoredExcerpt,
  type StoredSourceBook,
} from "./types";
import { exportWereadBook, listWereadNotebooks, readWereadApiKey, type GatewayFailure } from "./weread";

export type SyncReport =
  | {
      ok: true;
      books: number;
      excerpts: number;
      anchored: number;
      unanchored: number;
      bookmarks: number;
      quoteSearchTruncated: boolean;
    }
  | { ok: false; code: GatewayFailure["code"] | "missing-key" | "empty-import" | "cancelled"; message: string };

function librarySearcher(ctx: AnnotationSyncContext): QuoteSearcher {
  return async (bookId, queries) => {
    const usable = queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0)
      .slice(0, 12);
    if (usable.length === 0) return [];
    try {
      const hits = await ctx.domains.library.queries.books.searchText({ bookId, queries: usable, limit: 5 });
      return hits.map(
        (hit): QuoteHit => ({
          chapterTitle: hit.chapterTitle ?? "",
          snippet: hit.snippet,
          exact: hit.match === "exact",
        }),
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      console.warn("annotation-sync quote search failed", code);
      return "unavailable";
    }
  };
}

async function localBooks(ctx: AnnotationSyncContext): Promise<LocalBookRef[]> {
  const books = await ctx.domains.library.queries.books.list();
  return books.map((book) => ({ id: book.id, title: book.title, author: book.author }));
}

async function persist(ctx: AnnotationSyncContext, placed: PlacementResult): Promise<void> {
  await replaceGroup(ctx.services.storage, placed.source, placed.excerpts);
}

function summarize(results: PlacementResult[]): SyncReport {
  const excerpts = results.reduce((sum, result) => sum + result.excerpts.length, 0);
  return {
    ok: true,
    books: results.length,
    excerpts,
    anchored: results.reduce((sum, result) => sum + result.source.anchored, 0),
    unanchored: results.reduce((sum, result) => sum + result.source.unanchored, 0),
    bookmarks: results.reduce((sum, result) => sum + (result.source.bookmarkCount ?? 0), 0),
    quoteSearchTruncated: results.some((result) => result.quoteSearchTruncated),
  };
}

export async function syncWereadBooks(ctx: AnnotationSyncContext, bookId?: string): Promise<SyncReport> {
  const apiKey = readWereadApiKey(await ctx.services.secrets.get("api-key"));
  if (!apiKey) {
    return {
      ok: false,
      code: "missing-key",
      message: "Add a WeChat Reading API key (wrk-…) in the plugin settings before syncing.",
    };
  }
  const fetchFn = (url: string, init: RequestInit) => ctx.services.network.fetch(url, init);
  const notebooks = await listWereadNotebooks(fetchFn, apiKey);
  if (!notebooks.ok) return notebooks;
  const selected = bookId ? notebooks.data.filter((book) => book.bookId === bookId) : notebooks.data;
  const targets =
    bookId && selected.length === 0
      ? [{ bookId, title: bookId, author: "", reviewCount: 0, noteCount: 0, bookmarkCount: 0, sort: null }]
      : selected;
  if (bookId && targets.length === 0) {
    return { ok: false, code: "empty-import", message: "That WeChat Reading book has no notebook entry." };
  }
  const books = await localBooks(ctx);
  const links = await readLinks(ctx.services.storage);
  const search = librarySearcher(ctx);
  const placed: PlacementResult[] = [];
  let budget = 120;
  for (const notebook of targets.slice(0, 80)) {
    const exported = await exportWereadBook(fetchFn, apiKey, notebook.bookId, notebook.bookmarkCount);
    if (!exported.ok) return exported;
    const group = groupId("weread", notebook.bookId);
    const result = await placeExcerpts({
      source: "weread",
      sourceBookId: notebook.bookId,
      title: exported.data.title || notebook.title,
      author: exported.data.author || notebook.author,
      bookmarkCount: notebook.bookmarkCount,
      excerpts: exported.data.excerpts,
      books,
      forcedBookId: links[group] ?? null,
      search,
      quoteBudget: budget,
    });
    budget = Math.max(0, budget - result.quoteSearches);
    await persist(ctx, result);
    placed.push(result);
  }
  await refreshStatus(ctx.services.storage, null);
  return summarize(placed);
}

async function sha(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u001f")));
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function importParsedExport(
  ctx: AnnotationSyncContext,
  filename: string,
  text: string,
): Promise<SyncReport> {
  const parsed = parseAnnotationExport(filename, text);
  if (!parsed) return { ok: false, code: "empty-import", message: `No annotations were found in ${filename}.` };
  const sourceBookId = await sha([parsed.title, parsed.author]);
  const group = groupId("neoreader", sourceBookId);
  const excerpts = await Promise.all(
    parsed.annotations.map(async (annotation) => ({
      id: `neoreader:${await sha([parsed.title, annotation.chapter, annotation.quote, annotation.note])}`,
      source: "neoreader" as const,
      sourceBookId,
      kind: annotation.quote ? ("highlight" as const) : ("thought" as const),
      quote: annotation.quote.slice(0, 4000),
      note: annotation.note.slice(0, 4000),
      sourceTitle: parsed.title,
      sourceAuthor: parsed.author,
      sourceChapter: annotation.chapter,
      pageLabel: annotation.pageLabel,
      createdAt: annotation.createdAt,
    })),
  );
  const books = await localBooks(ctx);
  const links = await readLinks(ctx.services.storage);
  const result = await placeExcerpts({
    source: "neoreader",
    sourceBookId,
    title: parsed.title,
    author: parsed.author,
    bookmarkCount: null,
    excerpts,
    books,
    forcedBookId: links[group] ?? null,
    search: librarySearcher(ctx),
  });
  await persist(ctx, result);
  await refreshStatus(ctx.services.storage, null);
  return summarize([result]);
}

async function readResourceText(ctx: AnnotationSyncContext, id: string, size: number): Promise<string> {
  const cap = Math.min(size, 2 * 1024 * 1024);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < cap) {
    const chunk = await ctx.services.resources.read(id, offset, Math.min(1024 * 1024, cap - offset));
    chunks.push(new Uint8Array(chunk.data));
    offset = chunk.nextOffset;
    if (chunk.eof || chunk.data.byteLength === 0) break;
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

export async function importPickedFiles(ctx: AnnotationSyncContext): Promise<SyncReport> {
  const picked = await ctx.services.resources.pick({
    multiple: true,
    extensions: ["txt", "html", "htm", "md", "markdown"],
  });
  if (picked.cancelled || picked.resources.length === 0) {
    return { ok: false, code: "cancelled", message: "Import cancelled." };
  }
  return importResources(ctx, picked.resources);
}

export async function importPickedFolder(ctx: AnnotationSyncContext): Promise<SyncReport> {
  const picked = await ctx.services.resources.pickDirectory();
  if (picked.cancelled || !picked.directory) return { ok: false, code: "cancelled", message: "Import cancelled." };
  const resources: Array<{ id: string; name: string; size: number }> = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 20 && resources.length < 40; page += 1) {
      const listing = await ctx.services.resources.listDirectory(picked.directory.id, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of listing.entries) {
        if (entry.kind !== "file" || !/\.(txt|html|htm|md|markdown)$/i.test(entry.name)) continue;
        const opened = await ctx.services.resources.openDirectoryFile(picked.directory.id, entry.relativePath);
        resources.push(opened);
        if (resources.length >= 40) break;
      }
      if (!listing.nextCursor) break;
      cursor = listing.nextCursor;
    }
  } finally {
    await ctx.services.resources.releaseDirectory(picked.directory.id);
  }
  if (resources.length === 0) {
    return {
      ok: false,
      code: "empty-import",
      message: "That folder has no txt, html, or markdown annotation exports.",
    };
  }
  return importResources(ctx, resources);
}

async function importResources(
  ctx: AnnotationSyncContext,
  resources: Array<{ id: string; name: string; size: number }>,
): Promise<SyncReport> {
  const reports: SyncReport[] = [];
  try {
    for (const resource of resources) {
      const text = await readResourceText(ctx, resource.id, resource.size);
      reports.push(await importParsedExport(ctx, resource.name, text));
    }
  } finally {
    for (const resource of resources) {
      await ctx.services.resources.release(resource.id);
    }
  }
  const failed = reports.find((report) => !report.ok && report.code !== "empty-import");
  if (failed && !failed.ok) return failed;
  const imported = reports.filter((report) => report.ok);
  if (imported.length === 0) {
    return { ok: false, code: "empty-import", message: "No annotations were found in the selected files." };
  }
  return imported.reduce<SyncReport>(
    (sum, report) => {
      if (!sum.ok || !report.ok) return sum;
      return {
        ok: true,
        books: sum.books + report.books,
        excerpts: sum.excerpts + report.excerpts,
        anchored: sum.anchored + report.anchored,
        unanchored: sum.unanchored + report.unanchored,
        bookmarks: 0,
        quoteSearchTruncated: sum.quoteSearchTruncated || report.quoteSearchTruncated,
      };
    },
    { ok: true, books: 0, excerpts: 0, anchored: 0, unanchored: 0, bookmarks: 0, quoteSearchTruncated: false },
  );
}

export async function rematchGroup(ctx: AnnotationSyncContext, group: string): Promise<SyncReport> {
  const documents = await listDocuments<StoredExcerpt>(ctx.services.storage, EXCERPT_COLLECTION);
  const stored = documents.map((document) => document.data).filter((excerpt) => excerpt.group === group);
  const sourceDocument = await ctx.services.storage.collection(SOURCE_COLLECTION).get<StoredSourceBook>(group);
  if (!sourceDocument || stored.length === 0) {
    return { ok: false, code: "empty-import", message: "That imported book has no annotations to match again." };
  }
  const source = sourceDocument.data;
  const links = await readLinks(ctx.services.storage);
  const result = await placeExcerpts({
    source: source.source,
    sourceBookId: source.sourceBookId,
    title: source.title,
    author: source.author,
    bookmarkCount: source.bookmarkCount,
    excerpts: stored.map((excerpt) => ({
      id: excerpt.id,
      source: excerpt.source,
      sourceBookId: excerpt.sourceBookId,
      kind: excerpt.kind,
      quote: excerpt.quote,
      note: excerpt.note,
      sourceTitle: excerpt.sourceTitle,
      sourceAuthor: excerpt.sourceAuthor,
      sourceChapter: excerpt.sourceChapter,
      pageLabel: excerpt.pageLabel,
      createdAt: excerpt.createdAt,
    })),
    books: await localBooks(ctx),
    forcedBookId: links[group] ?? null,
    search: librarySearcher(ctx),
  });
  await persist(ctx, result);
  await refreshStatus(ctx.services.storage, null);
  return summarize([result]);
}

export function searchStoredExcerpts(excerpts: StoredExcerpt[], query: string, limit: number): StoredExcerpt[] {
  const needle = query.trim().toLowerCase();
  return excerpts
    .filter((excerpt) => {
      if (!needle) return true;
      return `${excerpt.quote}\n${excerpt.note}\n${excerpt.sourceTitle}\n${excerpt.sourceChapter}\n${excerpt.localTitle ?? ""}`
        .toLowerCase()
        .includes(needle);
    })
    .slice(0, limit);
}
