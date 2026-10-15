import { WEREAD_GATEWAY, WEREAD_SKILL_VERSION, groupId, type IncomingExcerpt } from "./types";
import { quoteOverlap } from "./match";

export type GatewayFailure = {
  ok: false;
  code: "unauthorized" | "upgrade-required" | "weread-error" | "network" | "invalid-response";
  message: string;
};

export type GatewaySuccess<T> = { ok: true; data: T };
export type GatewayResult<T> = GatewaySuccess<T> | GatewayFailure;

export type WereadFetch = (input: string, init: RequestInit) => Promise<Response>;

const KEY_PATTERN = /^wrk-[A-Za-z0-9_-]{6,128}$/;

export function readWereadApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return KEY_PATTERN.test(trimmed) ? trimmed : null;
}

function failure(code: GatewayFailure["code"], message: string): GatewayFailure {
  return { ok: false, code, message };
}

function idKey(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(value: unknown, max = 4000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function wereadCall(
  fetchFn: WereadFetch,
  apiKey: string,
  params: Record<string, string | number>,
): Promise<GatewayResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetchFn(WEREAD_GATEWAY, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ...params, skill_version: WEREAD_SKILL_VERSION }),
    });
  } catch {
    return failure("network", "WeChat Reading could not be reached.");
  }
  if (response.status === 401 || response.status === 403) {
    return failure("unauthorized", "WeChat Reading rejected the API key.");
  }
  if (!response.ok) return failure("weread-error", `WeChat Reading returned HTTP ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("invalid-response", "WeChat Reading returned a response that was not JSON.");
  }
  const record = asRecord(body);
  if (!record) return failure("invalid-response", "WeChat Reading returned an unexpected payload.");
  const upgrade = asRecord(record.upgrade_info);
  if (upgrade) {
    const message =
      textField(upgrade.message, 500) || "The WeChat Reading skill must be upgraded before sync can continue.";
    return failure("upgrade-required", message);
  }
  const errcode = numberField(record.errcode);
  if (errcode !== null && errcode !== 0) {
    const message = textField(record.errmsg, 300) || `WeChat Reading error ${errcode}.`;
    return failure("weread-error", message);
  }
  return { ok: true, data: record };
}

export type WereadNotebook = {
  bookId: string;
  title: string;
  author: string;
  reviewCount: number;
  noteCount: number;
  bookmarkCount: number;
  sort: number | null;
};

export async function listWereadNotebooks(
  fetchFn: WereadFetch,
  apiKey: string,
): Promise<GatewayResult<WereadNotebook[]>> {
  const books: WereadNotebook[] = [];
  let lastSort: number | undefined;
  for (let page = 0; page < 40; page += 1) {
    const params: Record<string, string | number> = { api_name: "/user/notebooks", count: 50 };
    if (lastSort !== undefined) params.lastSort = lastSort;
    const result = await wereadCall(fetchFn, apiKey, params);
    if (!result.ok) return result;
    const batch = Array.isArray(result.data.books) ? result.data.books : [];
    for (const entry of batch) {
      const record = asRecord(entry);
      const book = asRecord(record?.book);
      const bookId = textField(record?.bookId, 128);
      if (!record || !bookId) continue;
      books.push({
        bookId,
        title: textField(book?.title, 300) || bookId,
        author: textField(book?.author, 300),
        reviewCount: numberField(record.reviewCount) ?? 0,
        noteCount: numberField(record.noteCount) ?? 0,
        bookmarkCount: numberField(record.bookmarkCount) ?? 0,
        sort: numberField(record.sort),
      });
    }
    const hasMore = result.data.hasMore === 1;
    const tail = asRecord(batch[batch.length - 1]);
    const sort = numberField(tail?.sort);
    if (!hasMore || batch.length === 0 || sort === null || sort === lastSort) break;
    lastSort = sort;
  }
  return { ok: true, data: books };
}

type ChapterMeta = { title: string; index: number | null };

function chapterMap(value: unknown): Map<string, ChapterMeta> {
  const chapters = new Map<string, ChapterMeta>();
  if (!Array.isArray(value)) return chapters;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const key = idKey(record.chapterUid);
    if (!key) continue;
    chapters.set(key, { title: textField(record.title, 300), index: numberField(record.chapterIdx) });
  }
  return chapters;
}

function bookMeta(value: unknown): { title: string; author: string } {
  const book = asRecord(value);
  return {
    title: textField(book?.title, 300),
    author: textField(book?.author, 300) || textField(book?.authorName, 300),
  };
}

export type WereadBookExport = {
  bookId: string;
  title: string;
  author: string;
  bookmarkCount: number | null;
  excerpts: IncomingExcerpt[];
};

function isoFromUnix(value: unknown): string | null {
  const seconds = numberField(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function exportWereadBook(
  fetchFn: WereadFetch,
  apiKey: string,
  bookId: string,
  bookmarkCount: number | null = null,
): Promise<GatewayResult<WereadBookExport>> {
  const highlights = await wereadCall(fetchFn, apiKey, { api_name: "/book/bookmarklist", bookId });
  if (!highlights.ok) return highlights;
  const chapters = chapterMap(highlights.data.chapters);
  const meta = bookMeta(highlights.data.book);
  const group = groupId("weread", bookId);
  const excerpts: IncomingExcerpt[] = [];
  const updated = Array.isArray(highlights.data.updated) ? highlights.data.updated : [];
  for (const entry of updated) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.type === 0) continue;
    const quote = textField(record.markText);
    const id = textField(record.bookmarkId, 160);
    if (!quote || !id) continue;
    const chapter = chapters.get(idKey(record.chapterUid));
    excerpts.push({
      id: `weread:highlight:${id}`,
      source: "weread",
      sourceBookId: bookId,
      kind: "highlight",
      quote,
      note: "",
      sourceTitle: meta.title || bookId,
      sourceAuthor: meta.author,
      sourceChapter: chapter?.title ?? "",
      pageLabel: null,
      createdAt: isoFromUnix(record.createTime),
    });
  }

  let synckey = 0;
  for (let page = 0; page < 40; page += 1) {
    const reviews = await wereadCall(fetchFn, apiKey, {
      api_name: "/review/list/mine",
      bookid: bookId,
      synckey,
      count: 20,
    });
    if (!reviews.ok) return reviews;
    const batch = Array.isArray(reviews.data.reviews) ? reviews.data.reviews : [];
    for (const entry of batch) {
      const wrapper = asRecord(entry);
      const review = asRecord(wrapper?.review) ?? wrapper;
      if (!review) continue;
      const reviewId = textField(review.reviewId ?? wrapper?.reviewId, 160);
      const note = textField(review.content);
      const abstract = textField(review.abstract ?? review.markText);
      if (!reviewId || (!note && !abstract)) continue;
      const chapterName = textField(review.chapterName, 300);
      excerpts.push({
        id: `weread:thought:${reviewId}`,
        source: "weread",
        sourceBookId: bookId,
        kind: "thought",
        quote: abstract,
        note,
        sourceTitle: meta.title || bookId,
        sourceAuthor: meta.author,
        sourceChapter: chapterName,
        pageLabel: null,
        createdAt: isoFromUnix(review.createTime),
      });
    }
    const nextKey = numberField(reviews.data.synckey);
    if (reviews.data.hasMore !== 1 || nextKey === null || nextKey === synckey) break;
    synckey = nextKey;
  }

  return {
    ok: true,
    data: {
      bookId,
      title: meta.title || bookId,
      author: meta.author,
      bookmarkCount,
      excerpts: mergeThoughtsIntoHighlights(excerpts, group),
    },
  };
}

function mergeThoughtsIntoHighlights(excerpts: IncomingExcerpt[], group: string): IncomingExcerpt[] {
  const highlights = excerpts.filter((excerpt) => excerpt.kind === "highlight");
  const thoughts = excerpts.filter((excerpt) => excerpt.kind === "thought");
  const consumed = new Set<string>();
  for (const thought of thoughts) {
    if (!thought.quote) continue;
    const host = highlights.find(
      (highlight) => !consumed.has(thought.id) && quoteOverlap(highlight.quote, thought.quote) >= 0.9,
    );
    if (!host) continue;
    consumed.add(thought.id);
    if (thought.note && !host.note.includes(thought.note)) {
      host.note = [host.note, thought.note].filter(Boolean).join("\n").slice(0, 4000);
    }
    if (!host.sourceChapter && thought.sourceChapter) host.sourceChapter = thought.sourceChapter;
  }
  return [...highlights, ...thoughts.filter((thought) => !consumed.has(thought.id))].map((excerpt) => ({
    ...excerpt,
    sourceBookId: excerpt.sourceBookId,
    quote: excerpt.quote.slice(0, 4000),
    note: excerpt.note.slice(0, 4000),
    id: excerpt.id || `${group}:missing`,
  }));
}
