import { expect, test } from "bun:test";
import { positionForOpen } from "./open-reader-session";

const persisted = {
  cfi: "epubcfi(/6/4)",
  href: "ch1.html",
  progressPercent: 10,
  currentLocation: 1,
  totalLocations: 20,
};

test("a crash snapshot for this book replaces the last flushed position", () => {
  const raw = JSON.stringify({
    bookId: "book",
    cfi: "epubcfi(/6/8)",
    href: "ch2.html",
    progressPercent: 40,
    currentLocation: 8,
    totalLocations: 20,
  });
  expect(positionForOpen("book", persisted, raw)).toEqual({
    cfi: "epubcfi(/6/8)",
    href: "ch2.html",
    progressPercent: 40,
    currentLocation: 8,
    totalLocations: 20,
  });
});

test("another book's snapshot does not move this book", () => {
  const raw = JSON.stringify({ bookId: "other", cfi: "epubcfi(/6/8)", href: "ch2.html", progressPercent: 40 });
  expect(positionForOpen("book", persisted, raw)).toEqual(persisted);
});

test("a missing or broken snapshot keeps the flushed position", () => {
  expect(positionForOpen("book", persisted, null)).toEqual(persisted);
  expect(positionForOpen("book", persisted, "{")).toEqual(persisted);
  expect(positionForOpen("book", null, null)).toBeNull();
});
