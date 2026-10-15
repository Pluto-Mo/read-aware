import { describe, expect, test } from "bun:test";
import { errorCode } from "@read-aware/core";
import {
  collectDroppedBooks,
  ERR_FOLDER_TOO_LARGE,
  folderListingSources,
  folderSourcePath,
  isImportableBookName,
  MAX_FOLDER_BOOKS,
  MAX_FOLDER_DEPTH,
  parseParkedFolderPick,
  type DroppedEntry,
} from "./folder-import";

describe("isImportableBookName", () => {
  test("accepts the import formats, case-insensitively, including fb2.zip", () => {
    for (const name of ["Dune.epub", "a.PDF", "b.mobi", "c.azw3", "d.fb2.zip", "e.cbz", "f.txt", "g.xhtml"]) {
      expect(isImportableBookName(name)).toBe(true);
    }
  });
  test("rejects other files, plain archives and hidden files", () => {
    for (const name of ["cover.jpg", "archive.zip", "notes", ".hidden.epub", "._Dune.epub"]) {
      expect(isImportableBookName(name)).toBe(false);
    }
  });
});

describe("folderSourcePath", () => {
  test("joins the folder name and the path below it with slashes", () => {
    expect(folderSourcePath("Books", "Sci-fi/Dune.epub")).toBe("Books/Sci-fi/Dune.epub");
    expect(folderSourcePath("Books", "Sci-fi\\Dune.epub")).toBe("Books/Sci-fi/Dune.epub");
    expect(folderSourcePath("Books", "/Sci-fi//Dune.epub/")).toBe("Books/Sci-fi/Dune.epub");
  });
  test("refuses anything that is not plain relative segments", () => {
    expect(folderSourcePath("", "Dune.epub")).toBeNull();
    expect(folderSourcePath("Books", "")).toBeNull();
    expect(folderSourcePath("Books", "../Dune.epub")).toBeNull();
    expect(folderSourcePath("..", "Dune.epub")).toBeNull();
  });
});

describe("folderListingSources", () => {
  const sizeOf = async (path: string) => (path === "content://b" ? 77 : 0);

  test("lists books in natural order with provenance and resolved sizes", async () => {
    const sources = await folderListingSources(
      {
        rootName: "Books",
        truncated: false,
        files: [
          { path: "/x/Vol 10.epub", relativePath: "Series/Vol 10.epub", size: 10 },
          { path: "content://b", relativePath: "Series/Vol 2.epub", size: null },
          { path: "/x/cover.jpg", relativePath: "cover.jpg", size: 1 },
        ],
      },
      sizeOf,
    );
    expect(sources).toEqual([
      { kind: "native-path", path: "content://b", name: "Vol 2.epub", size: 77, sourcePath: "Books/Series/Vol 2.epub" },
      {
        kind: "native-path",
        path: "/x/Vol 10.epub",
        name: "Vol 10.epub",
        size: 10,
        sourcePath: "Books/Series/Vol 10.epub",
      },
    ]);
  });

  test("refuses a folder past the book limit instead of importing part of it", async () => {
    const attempt = folderListingSources({ rootName: "Books", truncated: true, files: [] }, sizeOf);
    await expect(attempt).rejects.toThrow();
    expect(errorCode(await attempt.catch((error: unknown) => error))).toBe(ERR_FOLDER_TOO_LARGE);
  });
});

describe("parseParkedFolderPick", () => {
  test("waits past outcomes of an earlier pick", () => {
    expect(parseParkedFolderPick(JSON.stringify({ generation: 1, status: "cancelled" }), 2)).toEqual({ kind: "stale" });
  });
  test("reports a cancel", () => {
    expect(parseParkedFolderPick(JSON.stringify({ generation: 2, status: "cancelled" }), 2)).toEqual({
      kind: "cancelled",
    });
  });
  test("throws native failures and malformed outcomes", () => {
    expect(() => parseParkedFolderPick(JSON.stringify({ generation: 2, status: "error", error: "x" }), 2)).toThrow();
    expect(() => parseParkedFolderPick(JSON.stringify({ generation: 2, status: "picked" }), 2)).toThrow();
    expect(() => parseParkedFolderPick("[]", 2)).toThrow();
  });
  test("reads a listing, treating unknown sizes as null and dropping bad rows", () => {
    const parked = JSON.stringify({
      generation: 2,
      status: "picked",
      rootName: "Books",
      truncated: false,
      files: [
        { path: "content://a", relativePath: "A.epub", size: -1 },
        { path: "content://b", relativePath: "B.epub", size: 5 },
        { relativePath: "no-path.epub" },
      ],
    });
    expect(parseParkedFolderPick(parked, 2)).toEqual({
      kind: "picked",
      listing: {
        rootName: "Books",
        truncated: false,
        files: [
          { path: "content://a", relativePath: "A.epub", size: null },
          { path: "content://b", relativePath: "B.epub", size: 5 },
        ],
      },
    });
  });
});

/** An in-memory drop: `tree` maps a folder's full path to its children. */
function fakeDrop(paths: string[]) {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) dirs.add("/" + parts.slice(0, index).join("/"));
  }
  const entry = (fullPath: string): DroppedEntry => {
    const name = fullPath.split("/").pop()!;
    if (dirs.has(fullPath)) {
      const children = [...new Set([...dirs, ...paths.map((path) => "/" + path)])].filter(
        (candidate) => candidate.startsWith(fullPath + "/") && !candidate.slice(fullPath.length + 1).includes("/"),
      );
      let served = false;
      return Object.assign(
        { name, fullPath, isFile: false, isDirectory: true },
        {
          createReader: () => ({
            readEntries: (success: (entries: DroppedEntry[]) => void) => {
              // Two batches then the end, like a real directory reader.
              const half = Math.ceil(children.length / 2);
              const batch = served ? children.slice(half) : children.slice(0, half);
              if (served) children.splice(0);
              served = true;
              success(batch.map(entry));
            },
          }),
        },
      );
    }
    return Object.assign(
      { name, fullPath, isFile: true, isDirectory: false },
      { file: (success: (file: File) => void) => success(new File(["x"], name)) },
    );
  };
  const top = [...new Set(paths.map((path) => "/" + path.split("/")[0]))];
  return top.map(entry);
}

describe("collectDroppedBooks", () => {
  test("walks dropped folders with provenance and keeps loose files as they were", async () => {
    const { sources, folders } = await collectDroppedBooks(
      fakeDrop([
        "Loose.epub",
        "Books/Vol 10.epub",
        "Books/Vol 2.epub",
        "Books/Sci-fi/Dune.epub",
        "Books/Sci-fi/cover.jpg",
        "Books/.git/x.epub",
        "Books/__MACOSX/Dune.epub",
      ]),
    );
    expect(folders).toEqual(["Books"]);
    expect(
      sources.map((source) =>
        source.kind === "file" ? [source.file.name, source.sourcePath ?? null] : ["unexpected", null],
      ),
    ).toEqual([
      ["Loose.epub", null],
      ["Dune.epub", "Books/Sci-fi/Dune.epub"],
      ["Vol 2.epub", "Books/Vol 2.epub"],
      ["Vol 10.epub", "Books/Vol 10.epub"],
    ]);
  });

  test("stops descending at the depth limit", async () => {
    const kept = Array.from({ length: MAX_FOLDER_DEPTH - 1 }, () => "d").join("/");
    const lost = Array.from({ length: MAX_FOLDER_DEPTH }, () => "d").join("/");
    const { sources } = await collectDroppedBooks(fakeDrop([`Books/${kept}/kept.epub`, `Books/${lost}/lost.epub`]));
    expect(sources.map((source) => (source.kind === "file" ? source.file.name : ""))).toEqual(["kept.epub"]);
  });

  test("refuses a dropped folder past the book limit", async () => {
    const paths = Array.from({ length: MAX_FOLDER_BOOKS + 1 }, (_, index) => `Books/${index}.txt`);
    const attempt = collectDroppedBooks(fakeDrop(paths));
    expect(errorCode(await attempt.catch((error: unknown) => error))).toBe(ERR_FOLDER_TOO_LARGE);
  });
});
