import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import type { LibraryBook } from "../lib/library-types";
import { useStartupBook } from "./useStartupBook";

test("startup resume waits for readiness, opens the last read book once and yields to newer user intent", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const values = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const globals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const books = [
    { id: "new-import", lastOpenedAt: null, updatedAt: "2026-09-14T00:00:00Z" },
    { id: "edited-old-book", lastOpenedAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" },
    { id: "last-read", lastOpenedAt: "2026-09-13T00:00:00Z" },
    { id: "invalid", lastOpenedAt: "not-a-date" },
  ] as LibraryBook[];
  const opened: string[] = [],
    failures: unknown[] = [];
  const base: Parameters<typeof useStartupBook>[0] = {
    startView: "resume",
    ready: false,
    idle: true,
    books,
    openBook: (book) => {
      opened.push(book.id);
    },
    reportError: (error) => {
      failures.push(error);
    },
  };
  let root: ReturnType<typeof createRoot> | undefined;
  let props = base;
  function Harness() {
    useStartupBook(props);
    return null;
  }
  async function render(next: Partial<typeof base> = {}) {
    props = { ...props, ...next };
    await act(async () => {
      root!.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
  }
  async function reset(next: Partial<typeof base> = {}, pin?: string) {
    if (root)
      await act(async () => {
        root!.unmount();
      });
    opened.length = 0;
    failures.length = 0;
    dom.window.localStorage.clear();
    if (pin) dom.window.localStorage.setItem("read-aware-open-reader", pin);
    props = { ...base, ...next };
    root = createRoot(dom.window.document.getElementById("root")!);
    await render();
  }
  try {
    await reset();
    expect(opened).toEqual([]);
    await render({ ready: true });
    expect(opened).toEqual(["last-read"]);
    await render({ books: [...books], idle: false });
    await render({ idle: true });
    expect(opened).toEqual(["last-read"]);

    await reset({ startView: "shelf" });
    await render({ startView: "resume", ready: true });
    expect(opened).toEqual([]);

    for (const event of ["pointerdown", "keydown"]) {
      await reset();
      dom.window.dispatchEvent(new dom.window.Event(event));
      await render({ ready: true });
      expect(opened).toEqual([]);
    }
    await reset();
    await render({ idle: false });
    await render({ idle: true, ready: true });
    expect(opened).toEqual([]);

    await reset({ books: [], ready: true });
    await render({ books });
    expect(opened).toEqual([]);
    await reset({ ready: true, books: books.filter((book) => !book.lastOpenedAt || book.id === "invalid") });
    expect(opened).toEqual([]);

    const failure = Error("Opening unavailable");
    await reset({
      ready: true,
      openBook: () => {
        throw failure;
      },
    });
    expect(failures).toEqual([failure]);
    await render({ books: [...books] });
    expect(failures).toEqual([failure]);

    await reset({ startView: "shelf", ready: false }, "edited-old-book");
    dom.window.dispatchEvent(new dom.window.Event("pointerdown"));
    await render({ ready: true });
    expect(opened).toEqual(["edited-old-book"]);

    await reset({ startView: "resume", ready: true }, "edited-old-book");
    expect(opened).toEqual(["edited-old-book"]);

    await reset({ startView: "shelf", ready: true }, "gone");
    expect(opened).toEqual([]);
    expect(dom.window.localStorage.getItem("read-aware-open-reader")).toBeNull();
  } finally {
    if (root)
      await act(async () => {
        root!.unmount();
      });
    dom.window.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
