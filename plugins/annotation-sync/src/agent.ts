import type { AnnotationSyncContext, StoredExcerpt } from "./types";
import { EXCERPT_COLLECTION } from "./types";
import { contextBlocksForBook, retrievalItems } from "./present";
import { listDocuments } from "./store";
import { searchStoredExcerpts } from "./sync";

const invalid = (): never => {
  throw Object.assign(new Error("Invalid annotation tool input"), { code: "plugin/invalid-input" });
};

function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid();
  return value.trim();
}

async function loadExcerpts(ctx: AnnotationSyncContext, bookId?: string): Promise<StoredExcerpt[]> {
  if (!bookId) {
    const documents = await listDocuments<StoredExcerpt>(ctx.services.storage, EXCERPT_COLLECTION);
    return documents.map((document) => document.data);
  }
  const excerpts: StoredExcerpt[] = [];
  let cursor: string | undefined;
  const collection = ctx.services.storage.collection(EXCERPT_COLLECTION);
  for (let page = 0; page < 20; page += 1) {
    const result = await collection.page<StoredExcerpt>({ limit: 200, bookId, ...(cursor ? { cursor } : {}) });
    if (result.status !== "ready") break;
    excerpts.push(...result.items.map((item) => item.data));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return excerpts;
}

export function registerAgentContributions(ctx: AnnotationSyncContext): void {
  ctx.contributions.agentTools.register({
    name: "list_imported_annotations",
    label: "Imported annotations",
    contexts: ["book", "global"],
    description:
      "List highlights and notes imported from WeChat Reading or a NeoReader export. Pass bookId to limit results to excerpts linked to that local ReadAware book, including unanchored excerpts whose source title matched. Omit bookId to search the whole import. Query is a case-insensitive substring of the quote, note, source title, or chapter. Anchored means the quote was found in the local book text; unanchored means it was kept as an excerpt because the edition differed or the text was not searchable. Bookmark bodies are never imported. This does not sync or call WeChat Reading.",
    parameters: {
      type: "object",
      properties: {
        bookId: { type: "string", minLength: 1, maxLength: 128 },
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    execute: async (params) => {
      const keys = Object.keys(params);
      if (keys.some((key) => !["bookId", "query", "limit"].includes(key))) return invalid();
      const limit = params.limit ?? 8;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) return invalid();
      const query = params.query === undefined ? "" : text(params.query, 200);
      const bookId = params.bookId === undefined ? undefined : text(params.bookId, 128);
      const scoped = bookId ? await loadExcerpts(ctx, bookId) : await loadExcerpts(ctx);
      const items = searchStoredExcerpts(scoped, query, limit);
      return {
        total: scoped.length,
        items: items.map((excerpt) => ({
          id: excerpt.id,
          source: excerpt.source,
          kind: excerpt.kind,
          anchor: excerpt.anchor,
          sourceTitle: excerpt.sourceTitle,
          sourceAuthor: excerpt.sourceAuthor,
          sourceChapter: excerpt.sourceChapter,
          pageLabel: excerpt.pageLabel,
          localBookId: excerpt.localBookId,
          quote: excerpt.quote.slice(0, 800),
          note: excerpt.note.slice(0, 800),
        })),
      };
    },
  });

  ctx.contributions.agentRetrievalProviders.register({
    id: "imported-annotations",
    label: "Imported annotations",
    description:
      "Search highlights and notes imported from WeChat Reading or NeoReader. In a book conversation, results are limited to excerpts linked to that book.",
    contexts: ["book", "global"],
    retrieve: async ({ scope, query, limit }) => {
      const scoped = scope.kind === "book" ? await loadExcerpts(ctx, scope.bookId) : await loadExcerpts(ctx);
      return retrievalItems(searchStoredExcerpts(scoped, query, Math.min(20, Math.max(1, limit))));
    },
  });

  ctx.contributions.agentContextProviders.register({
    id: "imported-annotations",
    contexts: ["book"],
    provide: async ({ scope }) => {
      if (scope.kind !== "book") return [];
      return contextBlocksForBook(scope.bookId, await loadExcerpts(ctx, scope.bookId));
    },
  });
}
