import { AppError } from "@read-aware/core";
import { formatFromName } from "./import-format";
import type { BookImportSource } from "./library-types";

/**
 * Folder imports. Each platform lists a picked folder on its own side —
 * desktop in Rust (`book_folder_pick`), Android and iOS natively under their
 * folder grants (see apps/desktop/src-tauri/src/book_folders.rs), dropped
 * folders through the web entry API — and every listing becomes ordinary
 * per-file import sources carrying their `sourcePath` provenance. Grouping by
 * the original folders is deliberately not an import option: the Agent reads
 * `sourcePath` and arranges collections when asked.
 */

/** Mirror `MAX_FOLDER_BOOKS` / `MAX_FOLDER_DEPTH` in book_folders.rs. */
export const MAX_FOLDER_BOOKS = 5000;
export const MAX_FOLDER_DEPTH = 32;

/** A folder holding more books than `MAX_FOLDER_BOOKS`: refused, not half-imported. */
export const ERR_FOLDER_TOO_LARGE = "library/folder-too-large";

export function folderTooLarge(): AppError {
  return new AppError(ERR_FOLDER_TOO_LARGE, `A folder import is limited to ${MAX_FOLDER_BOOKS} books`);
}

/** One importable book a platform found below the picked folder. */
export type FolderFile = {
  /** What the import pipeline reads: a path or a `content://` document URI. */
  path: string;
  /** `/`-separated path below the picked folder. */
  relativePath: string;
  /** Byte size, or null when the provider would not say. */
  size: number | null;
};

export type FolderListing = {
  rootName: string;
  files: FolderFile[];
  truncated: boolean;
};

/** Dotfiles and dot-folders, and the `__MACOSX` folder ZIP tools leave behind. */
export function isSkippedFolderEntry(name: string): boolean {
  return name.startsWith(".") || name === "__MACOSX";
}

/** A file a folder import picks up: one of the importable book formats. */
export function isImportableBookName(name: string): boolean {
  return !isSkippedFolderEntry(name) && formatFromName(name) !== null;
}

/**
 * The provenance a folder import records: the picked folder's name and the
 * path below it, `/`-separated (`Books/Sci-fi/Dune.epub`). Null when either
 * part cannot be expressed as plain relative segments.
 */
export function folderSourcePath(rootName: string, relativePath: string): string | null {
  const segments = [rootName, ...relativePath.split(/[\\/]/)].map((segment) => segment.trim());
  const relative = segments.slice(1).filter(Boolean);
  if (!segments[0] || relative.length === 0) return null;
  if ([segments[0], ...relative].some((segment) => segment === "." || segment === "..")) return null;
  return [segments[0], ...relative].join("/");
}

/** Natural order, so `Vol 2` precedes `Vol 10` the way a file manager lists them. */
export function compareFolderPaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Import sources for a native folder listing, in the folder's natural order.
 * `sizeOf` resolves the files whose size the platform could not report.
 */
export async function folderListingSources(
  listing: FolderListing,
  sizeOf: (path: string) => Promise<number>,
): Promise<BookImportSource[]> {
  if (listing.truncated || listing.files.length > MAX_FOLDER_BOOKS) throw folderTooLarge();
  const files = [...listing.files].sort((a, b) => compareFolderPaths(a.relativePath, b.relativePath));
  const sources: BookImportSource[] = [];
  for (const file of files) {
    const sourcePath = folderSourcePath(listing.rootName, file.relativePath);
    const name = file.relativePath.split("/").pop() ?? "";
    if (!sourcePath || !isImportableBookName(name)) continue;
    sources.push({
      kind: "native-path",
      path: file.path,
      name,
      size: file.size ?? (await sizeOf(file.path)),
      sourcePath,
    });
  }
  return sources;
}

/**
 * One parked mobile folder pick (the JSON `book_folder_pick_poll` returns).
 * `stale` = an outcome of an earlier, written-off pick: keep waiting.
 * `cancelled` = the user backed out. Native failures throw.
 */
export function parseParkedFolderPick(
  text: string,
  generation: number,
): { kind: "stale" } | { kind: "cancelled" } | { kind: "picked"; listing: FolderListing } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Malformed folder pick result");
  }
  const outcome = parsed as Record<string, unknown>;
  if (typeof outcome.generation !== "number") throw new Error("Malformed folder pick result");
  if (outcome.generation !== generation) return { kind: "stale" };
  if (outcome.status === "cancelled") return { kind: "cancelled" };
  if (outcome.status === "error") {
    const detail = typeof outcome.error === "string" ? outcome.error : "unknown";
    throw new Error(`Native folder pick failed: ${detail}`);
  }
  if (outcome.status !== "picked" || typeof outcome.rootName !== "string" || !Array.isArray(outcome.files)) {
    throw new Error("Malformed folder pick result");
  }
  const files: FolderFile[] = [];
  for (const entry of outcome.files as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, relativePath, size } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof relativePath !== "string") continue;
    files.push({
      path,
      relativePath,
      size: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null,
    });
  }
  return { kind: "picked", listing: { rootName: outcome.rootName, files, truncated: outcome.truncated === true } };
}

/** The subset of the File and Directory Entries API a drop walk needs. */
export type DroppedEntry = {
  readonly name: string;
  readonly fullPath: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
};
type DroppedFileEntry = DroppedEntry & {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
};
type DroppedDirectoryEntry = DroppedEntry & {
  createReader(): { readEntries(success: (entries: DroppedEntry[]) => void, failure?: (error: unknown) => void): void };
};

function readFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readChildren(entry: DroppedDirectoryEntry): Promise<DroppedEntry[]> {
  const reader = entry.createReader();
  const children: DroppedEntry[] = [];
  // readEntries hands a directory over in batches until it returns none.
  for (;;) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return children;
    children.push(...batch);
  }
}

/**
 * Import sources for an OS drop. Loose files import as before (no
 * provenance); dropped folders are walked like a folder import, each book
 * carrying the dropped folder's name and its path below it. `folders` names
 * the dropped folders, for the completion notice.
 */
export async function collectDroppedBooks(
  entries: readonly DroppedEntry[],
): Promise<{ sources: BookImportSource[]; folders: string[] }> {
  const loose: BookImportSource[] = [];
  const nested: { file: File; sourcePath: string }[] = [];
  const folders: string[] = [];
  const pending: { entry: DroppedEntry; depth: number }[] = [];
  for (const entry of entries) {
    if (entry.isFile && isImportableBookName(entry.name)) {
      loose.push({ kind: "file", file: await readFile(entry as DroppedFileEntry) });
    } else if (entry.isDirectory && !isSkippedFolderEntry(entry.name)) {
      folders.push(entry.name);
      pending.push({ entry, depth: 0 });
    }
  }
  while (pending.length > 0) {
    const { entry, depth } = pending.pop()!;
    for (const child of await readChildren(entry as DroppedDirectoryEntry)) {
      if (isSkippedFolderEntry(child.name)) continue;
      if (child.isDirectory) {
        if (depth + 1 < MAX_FOLDER_DEPTH) pending.push({ entry: child, depth: depth + 1 });
        continue;
      }
      if (!child.isFile || !isImportableBookName(child.name)) continue;
      if (nested.length === MAX_FOLDER_BOOKS) throw folderTooLarge();
      const sourcePath = folderSourcePath(...splitRoot(child.fullPath));
      if (!sourcePath) continue;
      nested.push({ file: await readFile(child as DroppedFileEntry), sourcePath });
    }
  }
  nested.sort((a, b) => compareFolderPaths(a.sourcePath, b.sourcePath));
  return {
    sources: [...loose, ...nested.map(({ file, sourcePath }) => ({ kind: "file" as const, file, sourcePath }))],
    folders,
  };
}

/** `/Books/Sci-fi/Dune.epub` → [`Books`, `Sci-fi/Dune.epub`]. */
function splitRoot(fullPath: string): [string, string] {
  const [root = "", ...rest] = fullPath.split("/").filter(Boolean);
  return [root, rest.join("/")];
}
