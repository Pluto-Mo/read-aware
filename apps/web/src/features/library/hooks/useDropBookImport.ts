import { useEffect, useRef, useState } from "react";
import { dragCarriesBooks } from "../../shelf/lib/book-drag";
import { collectDroppedBooks, isImportableBookName, type DroppedEntry } from "../lib/folder-import";
import type { BookImportSource } from "../lib/library-types";
import type { ImportBatch } from "./useBookImport";

/**
 * What an OS drop brings: loose books, and books in dropped folders (with
 * their place in them). The transfer is read synchronously — its items are
 * only readable while the drop event is being dispatched — and the folder
 * walk continues from the captured entries. Without the entries API only
 * the loose files are visible, which still import as before.
 */
function droppedBooks(transfer: DataTransfer | null): Promise<{ sources: BookImportSource[]; folders: string[] }> {
  const entries: DroppedEntry[] = Array.from(transfer?.items ?? []).flatMap((item) => {
    const entry = item.kind === "file" && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    return entry ? [entry] : [];
  });
  if (entries.length > 0) return collectDroppedBooks(entries);
  const files = Array.from(transfer?.files ?? []).filter((file) => isImportableBookName(file.name));
  return Promise.resolve({ sources: files.map((file) => ({ kind: "file" as const, file })), folders: [] });
}

/**
 * Window-wide drag-and-drop book import. Works because the Tauri window has
 * `dragDropEnabled: false` (native interception off for the menus feature's
 * HTML5 drags), which leaves OS file drops to arrive as plain HTML5 drop
 * events. "Files" alone doesn't prove an OS drop: WebKit tags a native image
 * drag (a shelf cover) with "Files" too, so drags carrying the shelf's own
 * book payload are excluded explicitly.
 *
 * Returns whether a file drag is currently hovering the window (drives the
 * drop overlay).
 */
export function useDropBookImport(
  importSources: (sources: BookImportSource[], batch?: ImportBatch) => Promise<unknown>,
  reportError: (error: unknown) => void,
): boolean {
  const importRef = useRef(importSources);
  importRef.current = importSources;
  const reportRef = useRef(reportError);
  reportRef.current = reportError;
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    // enter/leave fire per DOM node crossed; the counter nets them out so the
    // overlay survives moving across children and clears on leaving the window.
    let depth = 0;
    const hasFiles = (event: DragEvent) =>
      (event.dataTransfer?.types.includes("Files") ?? false) && !dragCarriesBooks(event.dataTransfer);

    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      if (event.target instanceof Element && event.target.closest("[data-plugin-file-drop]")) return;
      depth += 1;
      setDragActive(true);
    }
    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return;
      // Without this the webview navigates to the dropped file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    }
    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragActive(false);
      // Loose books import as they are; a dropped folder is walked like a
      // folder import, its books carrying their place in it.
      void droppedBooks(event.dataTransfer)
        .then(({ sources, folders }) => {
          if (sources.length === 0) return;
          return importRef.current(sources, folders.length > 0 ? { folders } : undefined);
        })
        .catch((error: unknown) => reportRef.current(error));
    }

    // A plugin target stops bubbling so it cannot also import into the shelf.
    // The window overlay must still clear, including a drop rejected by that target.
    function clearDropOverlay() {
      depth = 0;
      setDragActive(false);
    }
    function onTargetDrag(event: DragEvent) {
      if (event.target instanceof Element && event.target.closest("[data-plugin-file-drop]")) clearDropOverlay();
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("drop", clearDropOverlay, true);
    window.addEventListener("dragenter", onTargetDrag, true);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("drop", clearDropOverlay, true);
      window.removeEventListener("dragenter", onTargetDrag, true);
    };
  }, []);

  return dragActive;
}
