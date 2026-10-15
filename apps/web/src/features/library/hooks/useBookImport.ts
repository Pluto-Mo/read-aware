import { useCallback, useRef, type ChangeEvent } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { TFunction } from "i18next";
import { useToast } from "@read-aware/ui";
import { useTranslation } from "../../../i18n";
import { createLogger } from "../../../platform/logger";
import { importBook, type ImportOutcome } from "../lib/book-import";
import { canUseNativeFilePicker, pickBookFilesNative } from "../lib/pick-book-files";
import { pickBookFolderNative } from "../lib/pick-book-folder";
import {
  compareFolderPaths,
  folderSourcePath,
  folderTooLarge,
  isImportableBookName,
  isSkippedFolderEntry,
  MAX_FOLDER_BOOKS,
} from "../lib/folder-import";
import type { BookImportSource, LibraryBook } from "../lib/library-types";
import {
  importingCountAtom,
  libraryBooksAtom,
  pendingImportsAtom,
  removeBooks,
  upsertBook,
} from "../state/library-store";

export type { ImportOutcome };

const log = createLogger("library-import");

type BookImportOptions = {
  reportError: (error: unknown) => void;
};

/** What a batch came from, for its completion notice. */
export type ImportBatch = {
  /** Folder imports (picked or dropped): the folders' names. */
  folders?: string[];
};

/** The file name a failure notice shows. Logs carry it too — import file
 *  names are the logger's one sanctioned exception — but never the folders
 *  above it, which can describe the user's own directory layout. */
function sourceName(source: BookImportSource): string {
  return source.kind === "file" ? source.file.name : source.name;
}

/** The completion notice of a folder import: what landed, what was already there. */
function formatFolderNotice(imported: number, duplicates: number, t: TFunction<"shelf">): string {
  const parts = [
    t("folderImport.imported", { count: imported }),
    ...(duplicates > 0 ? [t("folderImport.duplicates", { count: duplicates })] : []),
    // Grouping by the original folders is the Agent's job, not an import option.
    ...(imported > 0 ? [t("folderImport.agentHint")] : []),
  ];
  return parts.join(" ");
}

function formatImportNotice(imported: number, duplicates: string[], t: TFunction<"shelf">): string {
  const skipped = t("importNotice.duplicate", {
    count: duplicates.length,
    title: duplicates[0],
  });
  return imported > 0 ? t("importNotice.combined", { skipped, count: imported }) : skipped;
}

/**
 * The import entry points — picker button, hidden file input, OS drops and
 * "open with" — funnel into `importSources`, which runs each source through
 * the import pipeline and lands the result on the shelf as it completes.
 *
 * The picker opens immediately (no work precedes the dialog); each book then
 * appears the moment its `book.imported` commits. The native staging step is
 * the only wait, and a placeholder holds the book's final slot while it runs.
 */
export function useBookImport({ reportError }: BookImportOptions) {
  const books = useAtomValue(libraryBooksAtom);
  const booksRef = useRef(books);
  booksRef.current = books;
  const setBooks = useSetAtom(libraryBooksAtom);
  const pendingBooks = useAtomValue(pendingImportsAtom);
  const setPendingBooks = useSetAtom(pendingImportsAtom);
  const importingCount = useAtomValue(importingCountAtom);
  const setImportingCount = useSetAtom(importingCountAtom);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  // Keep the latest translator in a ref so the callbacks below stay stable
  // (deps free of `t`) yet always format notices in the active language.
  const { t } = useTranslation("shelf");
  const tRef = useRef(t);
  tRef.current = t;

  const importSources = useCallback(
    async (sources: BookImportSource[], batch?: ImportBatch): Promise<ImportOutcome[]> => {
      if (sources.length === 0) return [];
      setImportingCount((current) => current + sources.length);

      let imported = 0;
      const duplicates: string[] = [];
      const failures: { name: string; error: unknown }[] = [];
      const outcomes: ImportOutcome[] = [];
      // Books landed by this batch count as known for the next source, so a
      // batch containing the same file twice dedupes against itself.
      const knownBooks: LibraryBook[] = [...booksRef.current];
      for (const source of sources) {
        let placeholderId: string | null = null;
        try {
          const outcome = await importBook(source, {
            t: tRef.current,
            knownBooks,
            onPrepared: (placeholder) => {
              placeholderId = placeholder.id;
              setPendingBooks((current) => upsertBook(current, placeholder));
            },
          });
          outcomes.push(outcome);
          if (outcome.status === "duplicate") {
            duplicates.push(outcome.book.title);
          } else {
            imported += 1;
            knownBooks.unshift(outcome.book);
            // Same id and sort fields as the placeholder: the slot does not move.
            setBooks((current) => upsertBook(current, outcome.book));
          }
        } catch (error) {
          failures.push({ name: sourceName(source), error });
        } finally {
          if (placeholderId) {
            const id = placeholderId;
            setPendingBooks((current) => removeBooks(current, [id]));
          }
          setImportingCount((current) => Math.max(0, current - 1));
        }
      }

      const t = tRef.current;
      if (sources.length === 1 && failures[0]) {
        reportError(failures[0].error);
      } else if (failures.length > 0) {
        // A batch reports its failures together — a folder of broken files
        // must not bury the shelf under one toast each. Every cause is logged.
        for (const failure of failures) log.error(`Could not import ${failure.name}`, failure.error);
        toast({
          variant: "destructive",
          title: t("importNotice.failedTitle"),
          description: t("importNotice.failed", { count: failures.length, title: failures[0]!.name }),
        });
      }
      const folders = batch?.folders ?? [];
      if (folders.length > 0) {
        toast({
          title:
            folders.length === 1
              ? t("folderImport.doneTitle", { folder: folders[0] })
              : t("folderImport.doneTitleMany", { count: folders.length }),
          description: formatFolderNotice(imported, duplicates.length, t),
        });
      } else if (duplicates.length > 0) {
        toast({
          title: t("workspace.importTitle"),
          description: formatImportNotice(imported, duplicates, t),
        });
      }
      return outcomes;
    },
    [reportError, setBooks, setImportingCount, setPendingBooks, toast],
  );

  // One native picker at a time: a re-trigger while a dialog is pending would
  // start a second concurrent import flow, and the import dedupe reads
  // the library before either flow has written — the same book lands twice.
  // (Safe to guard on the promise: Android routes around the dialog plugin's
  // lossy response channel via park-and-poll in pick-book-files.ts, so the
  // pick always settles — including on cancel.)
  const pickerPendingRef = useRef(false);

  const openImportPicker = useCallback(() => {
    // Desktop: the webview ignores the <input accept> filter, so drive the
    // native OS dialog (with a real Books format filter) instead. Web/dev falls
    // back to the hidden file input.
    if (canUseNativeFilePicker()) {
      if (pickerPendingRef.current) return;
      pickerPendingRef.current = true;
      void pickBookFilesNative(tRef.current)
        .then(importSources)
        .catch(reportError)
        .finally(() => {
          pickerPendingRef.current = false;
        });
      return;
    }

    importInputRef.current?.click();
  }, [importSources, reportError]);

  /** A picked folder with nothing importable in it says so instead of doing nothing. */
  const importFolder = useCallback(
    async (folder: string, sources: BookImportSource[]) => {
      if (sources.length === 0) {
        toast({
          title: tRef.current("workspace.importTitle"),
          description: tRef.current("folderImport.empty", { folder }),
        });
        return;
      }
      await importSources(sources, { folders: [folder] });
    },
    [importSources, toast],
  );

  const openFolderImportPicker = useCallback(() => {
    if (canUseNativeFilePicker()) {
      if (pickerPendingRef.current) return;
      pickerPendingRef.current = true;
      void pickBookFolderNative(tRef.current)
        .then(async (pick) => {
          if (!pick) return;
          // The platform's grant on the folder outlives the picker until
          // every book in it has been read.
          try {
            await importFolder(pick.rootName, pick.sources);
          } finally {
            await pick.release();
          }
        })
        .catch(reportError)
        .finally(() => {
          pickerPendingRef.current = false;
        });
      return;
    }

    folderInputRef.current?.click();
  }, [importFolder, reportError]);

  /** Browser fallback: a `webkitdirectory` input hands over the folder's files. */
  const handleFolderSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = Array.from(input.files ?? []);
      input.value = "";
      const root = files[0]?.webkitRelativePath.split("/")[0];
      if (!root) return;
      const books = files.flatMap((file) => {
        const [, ...rest] = file.webkitRelativePath.split("/");
        if (rest.length === 0 || rest.some(isSkippedFolderEntry) || !isImportableBookName(file.name)) return [];
        const sourcePath = folderSourcePath(root, rest.join("/"));
        return sourcePath ? [{ kind: "file" as const, file, sourcePath }] : [];
      });
      if (books.length > MAX_FOLDER_BOOKS) {
        reportError(folderTooLarge());
        return;
      }
      books.sort((a, b) => compareFolderPaths(a.sourcePath, b.sourcePath));
      await importFolder(root, books);
    },
    [importFolder, reportError],
  );

  const handleImportSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const sources: BookImportSource[] = Array.from(input.files ?? []).map((file) => ({
        kind: "file",
        file,
      }));
      input.value = "";
      await importSources(sources);
    },
    [importSources],
  );

  return {
    pendingBooks,
    importingCount,
    isImporting: importingCount > 0,
    importInputRef,
    folderInputRef,
    importSources,
    openImportPicker,
    openFolderImportPicker,
    handleImportSelection,
    handleFolderSelection,
  };
}
