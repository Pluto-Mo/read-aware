import type { PluginAgentContextBlock, PluginAgentRetrievalItem } from "@read-aware/plugin-types";
import type { StoredExcerpt } from "./types";

const CONTEXT_LIMIT = 8;
const CONTEXT_CHARS = 420;

function clip(value: string, max = CONTEXT_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function line(excerpt: StoredExcerpt, index: number): string {
  const where = [excerpt.sourceChapter, excerpt.pageLabel ? `p.${excerpt.pageLabel}` : ""].filter(Boolean).join(" · ");
  const anchor = excerpt.anchor === "anchored" ? "anchored" : "unanchored";
  const note = excerpt.note ? `\n   Note: ${clip(excerpt.note, 240)}` : "";
  const quote = excerpt.quote ? `“${clip(excerpt.quote)}”` : clip(excerpt.note, 240);
  return `${index}. [${anchor}${where ? ` · ${where}` : ""}] ${quote}${excerpt.quote ? note : ""}`;
}

export function contextBlocksForBook(bookId: string, excerpts: StoredExcerpt[]): PluginAgentContextBlock[] {
  const matched = excerpts.filter((excerpt) => excerpt.localBookId === bookId);
  if (matched.length === 0) return [];
  const ordered = [...matched].sort((left, right) => {
    if (left.anchor !== right.anchor) return left.anchor === "anchored" ? -1 : 1;
    return right.quoteScore - left.quoteScore;
  });
  const shown = ordered.slice(0, CONTEXT_LIMIT);
  const sourceTitle = shown[0]?.sourceTitle ?? "imported book";
  const hidden = ordered.length - shown.length;
  return [
    {
      title: "Imported annotations",
      content: [
        `Reader annotations imported for the local book from “${sourceTitle}”.`,
        "Anchored items matched this edition by quote text. Unanchored items belong to the same title match but the quote was not found in this file; they are still the reader's own marks.",
        "Do not treat a source chapter or page as a location in this EPUB.",
        ...shown.map(line),
        hidden > 0 ? `${hidden} more imported annotation(s) are available through the annotation tools.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

export function retrievalItems(excerpts: StoredExcerpt[]): PluginAgentRetrievalItem[] {
  return excerpts.map((excerpt) => ({
    title: excerpt.sourceTitle,
    location: [
      excerpt.anchor,
      excerpt.localTitle,
      excerpt.sourceChapter,
      excerpt.pageLabel ? `p.${excerpt.pageLabel}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    content: [excerpt.quote, excerpt.note].filter(Boolean).join("\n").slice(0, 1200),
  }));
}
