import type { PluginContext, PluginDocument } from "@read-aware/plugin-types";
import {
  EXCERPT_COLLECTION,
  LINK_KEY,
  SOURCE_COLLECTION,
  STATUS_KEY,
  type StoredExcerpt,
  type StoredSourceBook,
  type SyncStatus,
} from "./types";

type Storage = PluginContext["services"]["storage"];

export async function listDocuments<T>(storage: Storage, collection: string): Promise<PluginDocument<T>[]> {
  const documents: PluginDocument<T>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await storage.collection(collection).page<T>({ limit: 200, ...(cursor ? { cursor } : {}) });
    if (result.status === "stale-cursor") {
      documents.length = 0;
      cursor = undefined;
      continue;
    }
    documents.push(...result.items);
    if (!result.nextCursor) return documents;
    cursor = result.nextCursor;
  }
  return documents;
}

export async function replaceGroup(
  storage: Storage,
  source: StoredSourceBook,
  excerpts: StoredExcerpt[],
): Promise<void> {
  const existing = await listDocuments<StoredExcerpt>(storage, EXCERPT_COLLECTION);
  const excerptsStore = storage.collection(EXCERPT_COLLECTION);
  for (const document of existing) {
    if (document.data.group === source.group) await excerptsStore.delete(document.id);
  }
  for (const excerpt of excerpts) {
    await excerptsStore.put(excerpt.id, excerpt, excerpt.localBookId ? { bookId: excerpt.localBookId } : undefined);
  }
  await storage
    .collection(SOURCE_COLLECTION)
    .put(source.group, source, source.localBookId ? { bookId: source.localBookId } : undefined);
}

export async function readLinks(storage: Storage): Promise<Record<string, string>> {
  const stored = storage.get<Record<string, string>>(LINK_KEY);
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "string"));
}

export async function writeLink(storage: Storage, group: string, bookId: string | null): Promise<void> {
  const links = await readLinks(storage);
  if (bookId) links[group] = bookId;
  else delete links[group];
  await storage.set(LINK_KEY, links);
}

export async function writeStatus(storage: Storage, status: SyncStatus): Promise<void> {
  await storage.set(STATUS_KEY, status);
}

export function readStatus(storage: Storage): SyncStatus {
  const stored = storage.get<SyncStatus>(STATUS_KEY);
  if (!stored || typeof stored !== "object") {
    return { lastSyncAt: null, lastCode: null, excerpts: 0, anchored: 0, unanchored: 0 };
  }
  return stored;
}

export async function refreshStatus(storage: Storage, code: string | null): Promise<SyncStatus> {
  const excerpts = await listDocuments<StoredExcerpt>(storage, EXCERPT_COLLECTION);
  const status: SyncStatus = {
    lastSyncAt: new Date().toISOString(),
    lastCode: code,
    excerpts: excerpts.length,
    anchored: excerpts.filter((document) => document.data.anchor === "anchored").length,
    unanchored: excerpts.filter((document) => document.data.anchor === "unanchored").length,
  };
  await writeStatus(storage, status);
  return status;
}
