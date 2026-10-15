import type { ParsedAnnotation, ParsedExport } from "./types";

const DATE_PATTERN = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/;
const PAGE_PATTERN = /(?:Page\s*No\.?|第)\s*[:：]?\s*(\d+)\s*页?/;
const NOTE_PATTERN = /^(?:笔记|想法|备注|注释|批注|Note|Annotation)\s*[:：]\s*/i;

function clean(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return clean(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, digits: string) => {
        const code = Number(digits);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }),
  );
}

function createdFrom(line: string): string | null {
  const match = DATE_PATTERN.exec(line);
  if (!match) return null;
  const time = match[2] ?? "00:00:00";
  return `${match[1]}T${time}`;
}

function pageFrom(line: string): string | null {
  return PAGE_PATTERN.exec(line)?.[1] ?? null;
}

function splitQuoteNote(lines: string[]): { quote: string; note: string } {
  const index = lines.findIndex((line) => NOTE_PATTERN.test(line));
  if (index === -1) return { quote: clean(lines.join("\n")), note: "" };
  return {
    quote: clean(lines.slice(0, index).join("\n")),
    note: clean(lines.slice(index).join("\n").replace(NOTE_PATTERN, "")),
  };
}

export function parseBooxTxt(text: string): ParsedExport | null {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^-{3,}$/.test(line));
  if (lines.length === 0) return null;
  let title = lines[0] ?? "";
  const wrapped = title.match(/^<<\s*(.+?)\s*>>$/) ?? title.match(/^《\s*(.+?)\s*》$/);
  if (wrapped?.[1]) title = wrapped[1];
  title = title.replace(/\s*\(Z-Library\)\s*$/i, "").trim();
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line) {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);

  let chapter = "";
  const annotations: ParsedAnnotation[] = [];
  for (const block of blocks) {
    const last = block[block.length - 1] ?? "";
    if (DATE_PATTERN.test(last) && last.length < 80) {
      const body = block.slice(0, -1);
      const { quote, note } = splitQuoteNote(body);
      if (quote) {
        annotations.push({
          chapter,
          quote,
          note,
          pageLabel: pageFrom(last),
          createdAt: createdFrom(last),
        });
      }
      continue;
    }
    chapter = clean(block.join(" "));
  }
  if (!title || annotations.length === 0) return null;
  return { title, author: "", annotations };
}

export function parseBooxHtml(html: string): ParsedExport | null {
  const events: Array<{ kind: "title" | "chapter" | "quote"; text: string }> = [];
  const pattern = /<(h2|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1]?.toLowerCase();
    const attrs = match[2] ?? "";
    const text = decodeHtml(match[3] ?? "");
    if (!tag || !text) continue;
    if (tag === "h2") {
      events.push({ kind: "title", text: text.replace(/\s*\(Z-Library\)\s*$/i, "") });
      continue;
    }
    if (/font-size:\s*14pt/i.test(attrs)) events.push({ kind: "chapter", text });
    else if (/border-top:\s*1px\s+dotted/i.test(attrs)) {
      const withoutDate = text.replace(DATE_PATTERN, " ").replace(PAGE_PATTERN, " ");
      events.push({ kind: "quote", text: clean(withoutDate) });
    }
  }
  const title = events.find((event) => event.kind === "title")?.text ?? "";
  let chapter = "";
  const annotations: ParsedAnnotation[] = [];
  for (const event of events) {
    if (event.kind === "chapter") chapter = event.text;
    if (event.kind === "quote" && event.text) {
      const { quote, note } = splitQuoteNote([event.text]);
      if (quote) annotations.push({ chapter, quote, note, pageLabel: null, createdAt: null });
    }
  }
  if (!title || annotations.length === 0) return null;
  return { title, author: "", annotations };
}

export function parseAnnotationMarkdown(text: string): ParsedExport | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let title = "";
  let author = "";
  let chapter = "";
  const annotations: ParsedAnnotation[] = [];
  let quote: string[] | null = null;
  let note: string[] | null = null;

  const flush = () => {
    if (!quote) return;
    const quoteText = clean(quote.join("\n"));
    const noteText = clean((note ?? []).join("\n"));
    quote = null;
    note = null;
    if (quoteText) annotations.push({ chapter, quote: quoteText, note: noteText, pageLabel: null, createdAt: null });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      flush();
      chapter = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      title = line.slice(2).trim();
      continue;
    }
    const authorMatch = line.match(/^(?:author|authors|作者)\s*[:：]\s*(.+)$/i);
    if (authorMatch?.[1] && !quote) {
      author = authorMatch[1].trim();
      continue;
    }
    if (line.startsWith(">")) {
      if (note) flush();
      const piece = line.replace(/^>\s?/, "");
      quote = quote ? [...quote, piece] : [piece];
      continue;
    }
    if (chapter && /^[-*]\s+\S/.test(line)) {
      flush();
      quote = [line.replace(/^[-*]\s+/, "")];
      continue;
    }
    if (!line) {
      if (quote && note) flush();
      continue;
    }
    if (quote && NOTE_PATTERN.test(line)) {
      note = [line.replace(NOTE_PATTERN, "")];
      continue;
    }
    if (note) note.push(line);
  }
  flush();
  if (!title || annotations.length === 0) return null;
  return { title, author, annotations };
}

export function parseAnnotationExport(filename: string, text: string): ParsedExport | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return parseBooxHtml(text);
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return parseAnnotationMarkdown(text) ?? parseBooxTxt(text);
  return parseBooxTxt(text) ?? parseAnnotationMarkdown(text);
}
