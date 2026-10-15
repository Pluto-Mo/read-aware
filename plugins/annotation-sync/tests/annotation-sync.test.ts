import { describe, expect, test } from "bun:test";
import { authorConflicts, quoteWindows, rankTitleMatches, titleScore } from "../src/match";
import { parseAnnotationExport, parseBooxHtml, parseBooxTxt } from "../src/neoreader";
import { placeExcerpts } from "../src/place";
import { contextBlocksForBook } from "../src/present";
import { exportWereadBook, listWereadNotebooks, readWereadApiKey, wereadCall } from "../src/weread";
import { WEREAD_SKILL_VERSION } from "../src/types";
import type { StoredExcerpt } from "../src/types";

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  throw new Error("expected a JSON string body");
}

const localBooks = [
  { id: "local-1", title: "三体", author: "刘慈欣" },
  { id: "local-2", title: "三体：黑暗森林", author: "刘慈欣" },
  { id: "other", title: "活着", author: "余华" },
];

describe("book matching", () => {
  test("matches a title with a different subtitle and keeps a conflicting author out", () => {
    expect(titleScore("三体：地球往事", "三体")).toBeGreaterThan(0.72);
    const ranked = rankTitleMatches({ title: "三体：地球往事", author: "刘慈欣" }, localBooks);
    expect(ranked[0]?.book.id).toBe("local-1");
    expect(ranked.some((row) => row.book.id === "other")).toBe(false);
    expect(authorConflicts("刘慈欣", "余华")).toBe(true);
    expect(authorConflicts("刘慈欣", "Cixin Liu")).toBe(false);
  });

  test("builds short quote windows without assuming file offsets", () => {
    const quote = "宇宙就是一座黑暗森林，每个文明都是带枪的猎人。";
    expect(quoteWindows(quote)).toEqual([quote]);
    expect(quoteWindows("短")).toEqual([]);
  });
});

describe("WeChat Reading gateway", () => {
  test("accepts only wrk keys", () => {
    expect(readWereadApiKey(" wrk-abc_123456 ")).toBe("wrk-abc_123456");
    expect(readWereadApiKey("secret")).toBeNull();
  });

  test("flattens parameters and stops when the skill must be upgraded", async () => {
    const seen: unknown[] = [];
    const upgraded = await wereadCall(
      async (_url, init) => {
        seen.push(JSON.parse(requestBody(init.body)));
        return Response.json({ upgrade_info: { message: "请升级 skill" }, books: [] });
      },
      "wrk-abc_123456",
      { api_name: "/user/notebooks", count: 50 },
    );
    expect(seen[0]).toEqual({ api_name: "/user/notebooks", count: 50, skill_version: WEREAD_SKILL_VERSION });
    expect(upgraded.ok).toBe(false);
    if (!upgraded.ok) expect(upgraded.code).toBe("upgrade-required");
  });

  test("pages notebooks and exports highlights plus thoughts, skipping bookmark bodies", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(requestBody(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.api_name === "/user/notebooks" && body.lastSort === undefined) {
        return Response.json({
          hasMore: 1,
          books: [
            {
              bookId: "42",
              sort: 10,
              noteCount: 1,
              reviewCount: 1,
              bookmarkCount: 3,
              book: { title: "三体", author: "刘慈欣" },
            },
          ],
        });
      }
      if (body.api_name === "/user/notebooks") return Response.json({ hasMore: 0, books: [] });
      if (body.api_name === "/book/bookmarklist") {
        return Response.json({
          book: { title: "三体", author: "刘慈欣" },
          chapters: [{ chapterUid: 7, title: "第一章", chapterIdx: 1 }],
          updated: [
            { bookmarkId: "h1", type: 1, chapterUid: 7, markText: "宇宙就是一座黑暗森林。", createTime: 1_700_000_000 },
            { bookmarkId: "skip", type: 0, markText: "这是书签不应导出" },
          ],
        });
      }
      return Response.json({
        hasMore: 0,
        synckey: 9,
        reviews: [
          {
            review: {
              reviewId: "r1",
              abstract: "宇宙就是一座黑暗森林。",
              content: "像猎人。",
              chapterName: "第一章",
              createTime: 1_700_000_100,
            },
          },
          { review: { reviewId: "r2", content: "整本书的点评", createTime: 1_700_000_200 } },
        ],
      });
    };
    const notebooks = await listWereadNotebooks(fetchFn, "wrk-abc_123456");
    expect(notebooks.ok && notebooks.data[0]?.bookmarkCount).toBe(3);
    expect(calls.some((call) => call.lastSort === 10)).toBe(true);
    const exported = await exportWereadBook(fetchFn, "wrk-abc_123456", "42", 3);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.excerpts.map((excerpt) => excerpt.id)).toEqual(["weread:highlight:h1", "weread:thought:r2"]);
    expect(exported.data.excerpts[0]?.note).toBe("像猎人。");
    expect(exported.data.excerpts.some((excerpt) => excerpt.quote.includes("书签"))).toBe(false);
  });
});

describe("NeoReader exports", () => {
  test("parses a Boox text export", () => {
    const parsed = parseBooxTxt(
      `<<三体>>\n\n第一章\n\n宇宙就是一座黑暗森林。\n笔记：像猎人。\n2024-03-05 18:23:59 Page No.: 12\n-------------------\n`,
    );
    expect(parsed?.title).toBe("三体");
    expect(parsed?.annotations[0]).toMatchObject({
      chapter: "第一章",
      quote: "宇宙就是一座黑暗森林。",
      note: "像猎人。",
      pageLabel: "12",
      createdAt: "2024-03-05T18:23:59",
    });
  });

  test("parses Boox html and markdown", () => {
    const html = `<h2>三体 (Z-Library)</h2><div style="font-size: 14pt; text-align: left;">第一章</div><div style="padding-top: 1em; border-top: 1px dotted lightgray;">宇宙就是一座黑暗森林。 2024-03-05 18:23:59</div>`;
    expect(parseBooxHtml(html)?.annotations[0]?.quote).toContain("黑暗森林");
    const markdown = parseAnnotationExport(
      "notes.md",
      "# 三体\n作者：刘慈欣\n\n## 第一章\n\n> 宇宙就是一座黑暗森林。\n\n笔记：像猎人。\n",
    );
    expect(markdown).toMatchObject({
      title: "三体",
      author: "刘慈欣",
      annotations: [{ chapter: "第一章", quote: "宇宙就是一座黑暗森林。", note: "像猎人。" }],
    });
  });
});

describe("placement", () => {
  test("anchors a quote in a different edition and keeps a miss unanchored", async () => {
    const placed = await placeExcerpts({
      source: "weread",
      sourceBookId: "42",
      title: "三体",
      author: "刘慈欣",
      bookmarkCount: 2,
      books: localBooks,
      excerpts: [
        {
          id: "hit",
          source: "weread",
          sourceBookId: "42",
          kind: "highlight",
          quote: "宇宙就是一座黑暗森林，每个文明都是带枪的猎人。",
          note: "",
          sourceTitle: "三体",
          sourceAuthor: "刘慈欣",
          sourceChapter: "第一章 科学边界",
          pageLabel: null,
          createdAt: null,
        },
        {
          id: "miss",
          source: "weread",
          sourceBookId: "42",
          kind: "highlight",
          quote: "这段话在这个版本里被删掉了，所以对不上。",
          note: "仍要留给助手",
          sourceTitle: "三体",
          sourceAuthor: "刘慈欣",
          sourceChapter: "第二章",
          pageLabel: null,
          createdAt: null,
        },
      ],
      search: async (bookId, queries) => {
        if (bookId !== "local-1") return [];
        if (queries.some((query) => query.includes("黑暗森林"))) {
          return [{ chapterTitle: "第一章", snippet: "宇宙就是一座黑暗森林，每个文明都是带枪的猎人。", exact: true }];
        }
        return [];
      },
    });
    expect(placed.excerpts.find((excerpt) => excerpt.id === "hit")).toMatchObject({
      anchor: "anchored",
      localBookId: "local-1",
    });
    expect(placed.excerpts.find((excerpt) => excerpt.id === "miss")).toMatchObject({
      anchor: "unanchored",
      localBookId: "local-1",
    });
    expect(placed.source.bookmarkCount).toBe(2);
    const blocks = contextBlocksForBook("local-1", placed.excerpts as StoredExcerpt[]);
    expect(blocks[0]?.content).toContain("anchored");
    expect(blocks[0]?.content).toContain("unanchored");
    expect(contextBlocksForBook("other", placed.excerpts)).toEqual([]);
  });

  test("a manual local book is searched even when the titles differ", async () => {
    const placed = await placeExcerpts({
      source: "neoreader",
      sourceBookId: "abc",
      title: "The Three-Body Problem",
      author: "Cixin Liu",
      bookmarkCount: null,
      books: localBooks,
      forcedBookId: "local-1",
      excerpts: [
        {
          id: "forced",
          source: "neoreader",
          sourceBookId: "abc",
          kind: "highlight",
          quote: "宇宙就是一座黑暗森林。",
          note: "",
          sourceTitle: "The Three-Body Problem",
          sourceAuthor: "Cixin Liu",
          sourceChapter: "",
          pageLabel: null,
          createdAt: null,
        },
      ],
      search: async (bookId) =>
        bookId === "local-1" ? [{ chapterTitle: "一", snippet: "宇宙就是一座黑暗森林。", exact: true }] : [],
    });
    expect(placed.excerpts[0]).toMatchObject({ anchor: "anchored", localBookId: "local-1" });
  });
});
