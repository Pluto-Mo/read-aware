import type { PluginContext } from "@read-aware/plugin-types";

export const EXCERPT_COLLECTION = "excerpts";
export const SOURCE_COLLECTION = "sources";
export const LINK_KEY = "links";
export const STATUS_KEY = "status";
export const WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export const WEREAD_SKILL_VERSION = "1.0.5";
export const QUOTE_SEARCH_BUDGET = 120;

export type AnnotationSource = "weread" | "neoreader";
export type ExcerptKind = "highlight" | "thought";
export type AnchorState = "anchored" | "unanchored";

export type StoredExcerpt = {
  id: string;
  source: AnnotationSource;
  sourceBookId: string;
  group: string;
  kind: ExcerptKind;
  quote: string;
  note: string;
  sourceTitle: string;
  sourceAuthor: string;
  sourceChapter: string;
  pageLabel: string | null;
  createdAt: string | null;
  localBookId: string | null;
  localTitle: string | null;
  anchor: AnchorState;
  titleScore: number;
  quoteScore: number;
  chapterScore: number;
};

export type StoredSourceBook = {
  source: AnnotationSource;
  sourceBookId: string;
  group: string;
  title: string;
  author: string;
  highlightCount: number;
  thoughtCount: number;
  bookmarkCount: number | null;
  localBookId: string | null;
  localTitle: string | null;
  anchored: number;
  unanchored: number;
  syncedAt: string;
};

export type SyncStatus = {
  lastSyncAt: string | null;
  lastCode: string | null;
  excerpts: number;
  anchored: number;
  unanchored: number;
};

export type LocalBookRef = { id: string; title: string; author?: string };

export type QuoteHit = { chapterTitle: string; snippet: string; exact: boolean };

export type QuoteSearcher = (bookId: string, queries: string[]) => Promise<QuoteHit[] | "unavailable">;

export type IncomingExcerpt = {
  id: string;
  source: AnnotationSource;
  sourceBookId: string;
  kind: ExcerptKind;
  quote: string;
  note: string;
  sourceTitle: string;
  sourceAuthor: string;
  sourceChapter: string;
  pageLabel: string | null;
  createdAt: string | null;
};

export type ParsedAnnotation = {
  chapter: string;
  quote: string;
  note: string;
  pageLabel: string | null;
  createdAt: string | null;
};

export type ParsedExport = {
  title: string;
  author: string;
  annotations: ParsedAnnotation[];
};

export type AnnotationSyncContext = PluginContext & {
  domains: PluginContext["domains"] & {
    library: NonNullable<PluginContext["domains"]["library"]>;
  };
  services: PluginContext["services"] & {
    network: NonNullable<PluginContext["services"]["network"]>;
  };
  contributions: PluginContext["contributions"] & {
    agentTools: NonNullable<PluginContext["contributions"]["agentTools"]>;
    agentContextProviders: NonNullable<PluginContext["contributions"]["agentContextProviders"]>;
    agentRetrievalProviders: NonNullable<PluginContext["contributions"]["agentRetrievalProviders"]>;
  };
};

export function assertPluginCapabilities(ctx: PluginContext): asserts ctx is AnnotationSyncContext {
  if (!ctx.domains.library) throw new Error('Annotation Sync requires "library:read"');
  if (!ctx.services.network) throw new Error('Annotation Sync requires "service:network"');
  if (
    !ctx.contributions.agentTools ||
    !ctx.contributions.agentContextProviders ||
    !ctx.contributions.agentRetrievalProviders
  ) {
    throw new Error("Annotation Sync requires agent tools, context, and retrieval");
  }
}

export function groupId(source: AnnotationSource, sourceBookId: string): string {
  return `${source}:${sourceBookId.replace(/[\u0000-\u001f]/g, "")}`;
}
