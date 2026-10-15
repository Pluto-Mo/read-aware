// src/types.ts
var EXCERPT_COLLECTION = "excerpts";
var SOURCE_COLLECTION = "sources";
var LINK_KEY = "links";
var STATUS_KEY = "status";
var WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
var WEREAD_SKILL_VERSION = "1.0.5";
var QUOTE_SEARCH_BUDGET = 120;
function assertPluginCapabilities(ctx) {
  if (!ctx.domains.library)
    throw new Error('Annotation Sync requires "library:read"');
  if (!ctx.services.network)
    throw new Error('Annotation Sync requires "service:network"');
  if (!ctx.contributions.agentTools || !ctx.contributions.agentContextProviders || !ctx.contributions.agentRetrievalProviders) {
    throw new Error("Annotation Sync requires agent tools, context, and retrieval");
  }
}
function groupId(source, sourceBookId) {
  return `${source}:${sourceBookId.replace(/[\u0000-\u001f]/g, "")}`;
}

// src/present.ts
var CONTEXT_LIMIT = 8;
var CONTEXT_CHARS = 420;
function clip(value, max = CONTEXT_CHARS) {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
function line(excerpt, index) {
  const where = [excerpt.sourceChapter, excerpt.pageLabel ? `p.${excerpt.pageLabel}` : ""].filter(Boolean).join(" · ");
  const anchor = excerpt.anchor === "anchored" ? "anchored" : "unanchored";
  const note = excerpt.note ? `
   Note: ${clip(excerpt.note, 240)}` : "";
  const quote = excerpt.quote ? `“${clip(excerpt.quote)}”` : clip(excerpt.note, 240);
  return `${index}. [${anchor}${where ? ` · ${where}` : ""}] ${quote}${excerpt.quote ? note : ""}`;
}
function contextBlocksForBook(bookId, excerpts) {
  const matched = excerpts.filter((excerpt) => excerpt.localBookId === bookId);
  if (matched.length === 0)
    return [];
  const ordered = [...matched].sort((left, right) => {
    if (left.anchor !== right.anchor)
      return left.anchor === "anchored" ? -1 : 1;
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
        hidden > 0 ? `${hidden} more imported annotation(s) are available through the annotation tools.` : ""
      ].filter(Boolean).join(`
`)
    }
  ];
}
function retrievalItems(excerpts) {
  return excerpts.map((excerpt) => ({
    title: excerpt.sourceTitle,
    location: [
      excerpt.anchor,
      excerpt.localTitle,
      excerpt.sourceChapter,
      excerpt.pageLabel ? `p.${excerpt.pageLabel}` : ""
    ].filter(Boolean).join(" · "),
    content: [excerpt.quote, excerpt.note].filter(Boolean).join(`
`).slice(0, 1200)
  }));
}

// src/store.ts
async function listDocuments(storage, collection) {
  const documents = [];
  let cursor;
  for (let page = 0;page < 50; page += 1) {
    const result = await storage.collection(collection).page({ limit: 200, ...cursor ? { cursor } : {} });
    if (result.status === "stale-cursor") {
      documents.length = 0;
      cursor = undefined;
      continue;
    }
    documents.push(...result.items);
    if (!result.nextCursor)
      return documents;
    cursor = result.nextCursor;
  }
  return documents;
}
async function replaceGroup(storage, source, excerpts) {
  const existing = await listDocuments(storage, EXCERPT_COLLECTION);
  const excerptsStore = storage.collection(EXCERPT_COLLECTION);
  for (const document of existing) {
    if (document.data.group === source.group)
      await excerptsStore.delete(document.id);
  }
  for (const excerpt of excerpts) {
    await excerptsStore.put(excerpt.id, excerpt, excerpt.localBookId ? { bookId: excerpt.localBookId } : undefined);
  }
  await storage.collection(SOURCE_COLLECTION).put(source.group, source, source.localBookId ? { bookId: source.localBookId } : undefined);
}
async function readLinks(storage) {
  const stored = storage.get(LINK_KEY);
  if (!stored || typeof stored !== "object")
    return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "string"));
}
async function writeLink(storage, group, bookId) {
  const links = await readLinks(storage);
  if (bookId)
    links[group] = bookId;
  else
    delete links[group];
  await storage.set(LINK_KEY, links);
}
async function writeStatus(storage, status) {
  await storage.set(STATUS_KEY, status);
}
function readStatus(storage) {
  const stored = storage.get(STATUS_KEY);
  if (!stored || typeof stored !== "object") {
    return { lastSyncAt: null, lastCode: null, excerpts: 0, anchored: 0, unanchored: 0 };
  }
  return stored;
}
async function refreshStatus(storage, code) {
  const excerpts = await listDocuments(storage, EXCERPT_COLLECTION);
  const status = {
    lastSyncAt: new Date().toISOString(),
    lastCode: code,
    excerpts: excerpts.length,
    anchored: excerpts.filter((document) => document.data.anchor === "anchored").length,
    unanchored: excerpts.filter((document) => document.data.anchor === "unanchored").length
  };
  await writeStatus(storage, status);
  return status;
}

// src/neoreader.ts
var DATE_PATTERN = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/;
var PAGE_PATTERN = /(?:Page\s*No\.?|第)\s*[:：]?\s*(\d+)\s*页?/;
var NOTE_PATTERN = /^(?:笔记|想法|备注|注释|批注|Note|Annotation)\s*[:：]\s*/i;
function clean(value) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}
function decodeHtml(value) {
  return clean(value.replace(/<br\s*\/?>/gi, `
`).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, digits) => {
    const code = Number(digits);
    return code > 0 && code < 1114112 ? String.fromCodePoint(code) : "";
  }));
}
function createdFrom(line2) {
  const match = DATE_PATTERN.exec(line2);
  if (!match)
    return null;
  const time = match[2] ?? "00:00:00";
  return `${match[1]}T${time}`;
}
function pageFrom(line2) {
  return PAGE_PATTERN.exec(line2)?.[1] ?? null;
}
function splitQuoteNote(lines) {
  const index = lines.findIndex((line2) => NOTE_PATTERN.test(line2));
  if (index === -1)
    return { quote: clean(lines.join(`
`)), note: "" };
  return {
    quote: clean(lines.slice(0, index).join(`
`)),
    note: clean(lines.slice(index).join(`
`).replace(NOTE_PATTERN, ""))
  };
}
function parseBooxTxt(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line2) => line2.trim()).filter((line2) => !/^-{3,}$/.test(line2));
  if (lines.length === 0)
    return null;
  let title = lines[0] ?? "";
  const wrapped = title.match(/^<<\s*(.+?)\s*>>$/) ?? title.match(/^《\s*(.+?)\s*》$/);
  if (wrapped?.[1])
    title = wrapped[1];
  title = title.replace(/\s*\(Z-Library\)\s*$/i, "").trim();
  const blocks = [];
  let current = [];
  for (const line2 of lines.slice(1)) {
    if (!line2) {
      if (current.length)
        blocks.push(current);
      current = [];
      continue;
    }
    current.push(line2);
  }
  if (current.length)
    blocks.push(current);
  let chapter = "";
  const annotations = [];
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
          createdAt: createdFrom(last)
        });
      }
      continue;
    }
    chapter = clean(block.join(" "));
  }
  if (!title || annotations.length === 0)
    return null;
  return { title, author: "", annotations };
}
function parseBooxHtml(html) {
  const events = [];
  const pattern = /<(h2|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1]?.toLowerCase();
    const attrs = match[2] ?? "";
    const text = decodeHtml(match[3] ?? "");
    if (!tag || !text)
      continue;
    if (tag === "h2") {
      events.push({ kind: "title", text: text.replace(/\s*\(Z-Library\)\s*$/i, "") });
      continue;
    }
    if (/font-size:\s*14pt/i.test(attrs))
      events.push({ kind: "chapter", text });
    else if (/border-top:\s*1px\s+dotted/i.test(attrs)) {
      const withoutDate = text.replace(DATE_PATTERN, " ").replace(PAGE_PATTERN, " ");
      events.push({ kind: "quote", text: clean(withoutDate) });
    }
  }
  const title = events.find((event) => event.kind === "title")?.text ?? "";
  let chapter = "";
  const annotations = [];
  for (const event of events) {
    if (event.kind === "chapter")
      chapter = event.text;
    if (event.kind === "quote" && event.text) {
      const { quote, note } = splitQuoteNote([event.text]);
      if (quote)
        annotations.push({ chapter, quote, note, pageLabel: null, createdAt: null });
    }
  }
  if (!title || annotations.length === 0)
    return null;
  return { title, author: "", annotations };
}
function parseAnnotationMarkdown(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let title = "";
  let author = "";
  let chapter = "";
  const annotations = [];
  let quote = null;
  let note = null;
  const flush = () => {
    if (!quote)
      return;
    const quoteText = clean(quote.join(`
`));
    const noteText = clean((note ?? []).join(`
`));
    quote = null;
    note = null;
    if (quoteText)
      annotations.push({ chapter, quote: quoteText, note: noteText, pageLabel: null, createdAt: null });
  };
  for (const raw of lines) {
    const line2 = raw.trim();
    if (line2.startsWith("## ")) {
      flush();
      chapter = line2.slice(3).trim();
      continue;
    }
    if (line2.startsWith("# ")) {
      flush();
      title = line2.slice(2).trim();
      continue;
    }
    const authorMatch = line2.match(/^(?:author|authors|作者)\s*[:：]\s*(.+)$/i);
    if (authorMatch?.[1] && !quote) {
      author = authorMatch[1].trim();
      continue;
    }
    if (line2.startsWith(">")) {
      if (note)
        flush();
      const piece = line2.replace(/^>\s?/, "");
      quote = quote ? [...quote, piece] : [piece];
      continue;
    }
    if (chapter && /^[-*]\s+\S/.test(line2)) {
      flush();
      quote = [line2.replace(/^[-*]\s+/, "")];
      continue;
    }
    if (!line2) {
      if (quote && note)
        flush();
      continue;
    }
    if (quote && NOTE_PATTERN.test(line2)) {
      note = [line2.replace(NOTE_PATTERN, "")];
      continue;
    }
    if (note)
      note.push(line2);
  }
  flush();
  if (!title || annotations.length === 0)
    return null;
  return { title, author, annotations };
}
function parseAnnotationExport(filename, text) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm"))
    return parseBooxHtml(text);
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return parseAnnotationMarkdown(text) ?? parseBooxTxt(text);
  return parseBooxTxt(text) ?? parseAnnotationMarkdown(text);
}

// src/match.ts
function normalizeMatchText(value) {
  return value.normalize("NFKC").toLowerCase().replace(/\u3000/g, "").replace(/[\s\p{P}\p{S}]+/gu, "");
}
function bigramCounts(value) {
  const counts = new Map;
  for (let index = 0;index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
function diceCoefficient(left, right) {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b)
    return 0;
  if (a === b)
    return 1;
  if (a.length < 2 || b.length < 2)
    return 0;
  const leftGrams = bigramCounts(a);
  const rightGrams = bigramCounts(b);
  let overlap = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (const count of leftGrams.values())
    leftCount += count;
  for (const count of rightGrams.values())
    rightCount += count;
  for (const [gram, count] of leftGrams)
    overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  return 2 * overlap / (leftCount + rightCount);
}
function titleVariants(title) {
  const trimmed = title.trim().replace(/\s*\(z-library\)\s*$/i, "");
  const head = trimmed.split(/\s*[:：—–|]\s*/)[0]?.trim() ?? trimmed;
  return [...new Set([trimmed, head].filter((part) => part.length > 0))];
}
function containmentScore(left, right) {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b)
    return 0;
  if (a === b)
    return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter < 4 || shorter / longer < 0.6)
    return 0;
  if (a.includes(b) || b.includes(a))
    return shorter / longer;
  return 0;
}
function titleScore(sourceTitle, localTitle) {
  let best = 0;
  for (const source of titleVariants(sourceTitle)) {
    for (const local of titleVariants(localTitle)) {
      best = Math.max(best, diceCoefficient(source, local), containmentScore(source, local));
    }
  }
  return best;
}
function hasHan(value) {
  return /\p{Script=Han}/u.test(value);
}
function hasLatin(value) {
  return /\p{Script=Latin}/u.test(value);
}
function authorConflicts(sourceAuthor, localAuthor) {
  const source = sourceAuthor.trim();
  const local = localAuthor?.trim() ?? "";
  if (!source || !local)
    return false;
  const normalizedSource = normalizeMatchText(source);
  const normalizedLocal = normalizeMatchText(local);
  if (!normalizedSource || !normalizedLocal)
    return false;
  if (normalizedSource.includes(normalizedLocal) || normalizedLocal.includes(normalizedSource))
    return false;
  const comparable = hasHan(source) && hasHan(local) || hasLatin(source) && hasLatin(local) && !hasHan(source) && !hasHan(local);
  if (!comparable)
    return false;
  return diceCoefficient(source, local) < 0.34;
}
function rankTitleMatches(source, books) {
  return books.map((book) => ({ book, titleScore: titleScore(source.title, book.title) })).filter((row) => row.titleScore >= 0.72 && !authorConflicts(source.author, row.book.author)).sort((left, right) => right.titleScore - left.titleScore);
}
function quoteWindows(quote) {
  const compact = quote.replace(/\s+/g, " ").trim();
  if (compact.length < 4)
    return [];
  if (compact.length <= 80)
    return [compact];
  const size = 36;
  const middle = Math.max(0, Math.floor((compact.length - size) / 2));
  const windows = [compact.slice(middle, middle + size), compact.slice(0, size)];
  return [...new Set(windows.filter((window) => window.trim().length >= 4))].slice(0, 2);
}
function quoteOverlap(quote, snippet) {
  const left = normalizeMatchText(quote);
  const right = normalizeMatchText(snippet);
  if (!left || !right)
    return 0;
  if (left === right)
    return 1;
  if (right.includes(left) || left.includes(right)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return shorter / longer;
  }
  return diceCoefficient(quote, snippet);
}
function chapterOverlap(sourceChapter, localChapter) {
  if (!sourceChapter.trim() || !localChapter.trim())
    return 0;
  return Math.max(diceCoefficient(sourceChapter, localChapter), containmentScore(sourceChapter, localChapter));
}

// src/place.ts
async function placeExcerpts(input) {
  const group = groupId(input.source, input.sourceBookId);
  const forced = input.forcedBookId ? input.books.find((book) => book.id === input.forcedBookId) : undefined;
  const ranked = forced ? [{ book: forced, titleScore: 1 }] : rankTitleMatches({ title: input.title, author: input.author }, input.books).slice(0, 3);
  const primary = ranked[0];
  let remaining = input.quoteBudget ?? QUOTE_SEARCH_BUDGET;
  let quoteSearches = 0;
  let quoteSearchTruncated = false;
  const placed = [];
  for (const excerpt of input.excerpts) {
    const windows = excerpt.quote ? quoteWindows(excerpt.quote) : [];
    let best = null;
    if (windows.length > 0 && ranked.length > 0 && remaining <= 0)
      quoteSearchTruncated = true;
    const canSearch = windows.length > 0 && remaining > 0 && ranked.length > 0;
    if (canSearch) {
      for (const candidate of ranked) {
        if (remaining <= 0)
          break;
        remaining -= 1;
        quoteSearches += 1;
        const hits = await input.search(candidate.book.id, windows);
        if (hits === "unavailable" || hits.length === 0)
          continue;
        for (const hit of hits) {
          const overlap = quoteOverlap(excerpt.quote, hit.snippet);
          const quoteScore = hit.exact ? Math.max(overlap, 0.75) : overlap;
          if (quoteScore < 0.55)
            continue;
          const chapterScore = chapterOverlap(excerpt.sourceChapter, hit.chapterTitle);
          const score = quoteScore + chapterScore * 0.15;
          const current = best ? best.quoteScore + best.chapterScore * 0.15 : -1;
          if (score > current) {
            best = {
              book: candidate.book,
              titleScore: candidate.titleScore,
              quoteScore,
              chapterScore,
              chapterTitle: hit.chapterTitle
            };
          }
        }
        if (best && best.quoteScore >= 0.8)
          break;
      }
    }
    const linked = best?.book ?? primary?.book ?? null;
    placed.push({
      id: excerpt.id,
      source: excerpt.source,
      sourceBookId: input.sourceBookId,
      group,
      kind: excerpt.kind,
      quote: excerpt.quote,
      note: excerpt.note,
      sourceTitle: input.title,
      sourceAuthor: input.author,
      sourceChapter: excerpt.sourceChapter,
      pageLabel: excerpt.pageLabel,
      createdAt: excerpt.createdAt,
      localBookId: linked?.id ?? null,
      localTitle: linked?.title ?? null,
      anchor: best ? "anchored" : "unanchored",
      titleScore: best?.titleScore ?? primary?.titleScore ?? 0,
      quoteScore: best?.quoteScore ?? 0,
      chapterScore: best?.chapterScore ?? 0
    });
  }
  const anchored = placed.filter((excerpt) => excerpt.anchor === "anchored").length;
  return {
    excerpts: placed,
    quoteSearches,
    quoteSearchTruncated,
    source: {
      source: input.source,
      sourceBookId: input.sourceBookId,
      group,
      title: input.title,
      author: input.author,
      highlightCount: placed.filter((excerpt) => excerpt.kind === "highlight").length,
      thoughtCount: placed.filter((excerpt) => excerpt.kind === "thought").length,
      bookmarkCount: input.bookmarkCount,
      localBookId: primary?.book.id ?? null,
      localTitle: primary?.book.title ?? null,
      anchored,
      unanchored: placed.length - anchored,
      syncedAt: input.now ?? new Date().toISOString()
    }
  };
}

// src/weread.ts
var KEY_PATTERN = /^wrk-[A-Za-z0-9_-]{6,128}$/;
function readWereadApiKey(value) {
  const trimmed = value?.trim() ?? "";
  return KEY_PATTERN.test(trimmed) ? trimmed : null;
}
function failure(code, message) {
  return { ok: false, code, message };
}
function idKey(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function textField(value, max = 4000) {
  if (typeof value !== "string")
    return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}
function numberField(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
async function wereadCall(fetchFn, apiKey, params) {
  let response;
  try {
    response = await fetchFn(WEREAD_GATEWAY, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ ...params, skill_version: WEREAD_SKILL_VERSION })
    });
  } catch {
    return failure("network", "WeChat Reading could not be reached.");
  }
  if (response.status === 401 || response.status === 403) {
    return failure("unauthorized", "WeChat Reading rejected the API key.");
  }
  if (!response.ok)
    return failure("weread-error", `WeChat Reading returned HTTP ${response.status}.`);
  let body;
  try {
    body = await response.json();
  } catch {
    return failure("invalid-response", "WeChat Reading returned a response that was not JSON.");
  }
  const record = asRecord(body);
  if (!record)
    return failure("invalid-response", "WeChat Reading returned an unexpected payload.");
  const upgrade = asRecord(record.upgrade_info);
  if (upgrade) {
    const message = textField(upgrade.message, 500) || "The WeChat Reading skill must be upgraded before sync can continue.";
    return failure("upgrade-required", message);
  }
  const errcode = numberField(record.errcode);
  if (errcode !== null && errcode !== 0) {
    const message = textField(record.errmsg, 300) || `WeChat Reading error ${errcode}.`;
    return failure("weread-error", message);
  }
  return { ok: true, data: record };
}
async function listWereadNotebooks(fetchFn, apiKey) {
  const books = [];
  let lastSort;
  for (let page = 0;page < 40; page += 1) {
    const params = { api_name: "/user/notebooks", count: 50 };
    if (lastSort !== undefined)
      params.lastSort = lastSort;
    const result = await wereadCall(fetchFn, apiKey, params);
    if (!result.ok)
      return result;
    const batch = Array.isArray(result.data.books) ? result.data.books : [];
    for (const entry of batch) {
      const record = asRecord(entry);
      const book = asRecord(record?.book);
      const bookId = textField(record?.bookId, 128);
      if (!record || !bookId)
        continue;
      books.push({
        bookId,
        title: textField(book?.title, 300) || bookId,
        author: textField(book?.author, 300),
        reviewCount: numberField(record.reviewCount) ?? 0,
        noteCount: numberField(record.noteCount) ?? 0,
        bookmarkCount: numberField(record.bookmarkCount) ?? 0,
        sort: numberField(record.sort)
      });
    }
    const hasMore = result.data.hasMore === 1;
    const tail = asRecord(batch[batch.length - 1]);
    const sort = numberField(tail?.sort);
    if (!hasMore || batch.length === 0 || sort === null || sort === lastSort)
      break;
    lastSort = sort;
  }
  return { ok: true, data: books };
}
function chapterMap(value) {
  const chapters = new Map;
  if (!Array.isArray(value))
    return chapters;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record)
      continue;
    const key = idKey(record.chapterUid);
    if (!key)
      continue;
    chapters.set(key, { title: textField(record.title, 300), index: numberField(record.chapterIdx) });
  }
  return chapters;
}
function bookMeta(value) {
  const book = asRecord(value);
  return {
    title: textField(book?.title, 300),
    author: textField(book?.author, 300) || textField(book?.authorName, 300)
  };
}
function isoFromUnix(value) {
  const seconds = numberField(value);
  if (seconds === null || seconds <= 0)
    return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
async function exportWereadBook(fetchFn, apiKey, bookId, bookmarkCount = null) {
  const highlights = await wereadCall(fetchFn, apiKey, { api_name: "/book/bookmarklist", bookId });
  if (!highlights.ok)
    return highlights;
  const chapters = chapterMap(highlights.data.chapters);
  const meta = bookMeta(highlights.data.book);
  const group = groupId("weread", bookId);
  const excerpts = [];
  const updated = Array.isArray(highlights.data.updated) ? highlights.data.updated : [];
  for (const entry of updated) {
    const record = asRecord(entry);
    if (!record)
      continue;
    if (record.type === 0)
      continue;
    const quote = textField(record.markText);
    const id = textField(record.bookmarkId, 160);
    if (!quote || !id)
      continue;
    const chapter = chapters.get(idKey(record.chapterUid));
    excerpts.push({
      id: `weread:highlight:${id}`,
      source: "weread",
      sourceBookId: bookId,
      kind: "highlight",
      quote,
      note: "",
      sourceTitle: meta.title || bookId,
      sourceAuthor: meta.author,
      sourceChapter: chapter?.title ?? "",
      pageLabel: null,
      createdAt: isoFromUnix(record.createTime)
    });
  }
  let synckey = 0;
  for (let page = 0;page < 40; page += 1) {
    const reviews = await wereadCall(fetchFn, apiKey, {
      api_name: "/review/list/mine",
      bookid: bookId,
      synckey,
      count: 20
    });
    if (!reviews.ok)
      return reviews;
    const batch = Array.isArray(reviews.data.reviews) ? reviews.data.reviews : [];
    for (const entry of batch) {
      const wrapper = asRecord(entry);
      const review = asRecord(wrapper?.review) ?? wrapper;
      if (!review)
        continue;
      const reviewId = textField(review.reviewId ?? wrapper?.reviewId, 160);
      const note = textField(review.content);
      const abstract = textField(review.abstract ?? review.markText);
      if (!reviewId || !note && !abstract)
        continue;
      const chapterName = textField(review.chapterName, 300);
      excerpts.push({
        id: `weread:thought:${reviewId}`,
        source: "weread",
        sourceBookId: bookId,
        kind: "thought",
        quote: abstract,
        note,
        sourceTitle: meta.title || bookId,
        sourceAuthor: meta.author,
        sourceChapter: chapterName,
        pageLabel: null,
        createdAt: isoFromUnix(review.createTime)
      });
    }
    const nextKey = numberField(reviews.data.synckey);
    if (reviews.data.hasMore !== 1 || nextKey === null || nextKey === synckey)
      break;
    synckey = nextKey;
  }
  return {
    ok: true,
    data: {
      bookId,
      title: meta.title || bookId,
      author: meta.author,
      bookmarkCount,
      excerpts: mergeThoughtsIntoHighlights(excerpts, group)
    }
  };
}
function mergeThoughtsIntoHighlights(excerpts, group) {
  const highlights = excerpts.filter((excerpt) => excerpt.kind === "highlight");
  const thoughts = excerpts.filter((excerpt) => excerpt.kind === "thought");
  const consumed = new Set;
  for (const thought of thoughts) {
    if (!thought.quote)
      continue;
    const host = highlights.find((highlight) => !consumed.has(thought.id) && quoteOverlap(highlight.quote, thought.quote) >= 0.9);
    if (!host)
      continue;
    consumed.add(thought.id);
    if (thought.note && !host.note.includes(thought.note)) {
      host.note = [host.note, thought.note].filter(Boolean).join(`
`).slice(0, 4000);
    }
    if (!host.sourceChapter && thought.sourceChapter)
      host.sourceChapter = thought.sourceChapter;
  }
  return [...highlights, ...thoughts.filter((thought) => !consumed.has(thought.id))].map((excerpt) => ({
    ...excerpt,
    sourceBookId: excerpt.sourceBookId,
    quote: excerpt.quote.slice(0, 4000),
    note: excerpt.note.slice(0, 4000),
    id: excerpt.id || `${group}:missing`
  }));
}

// src/sync.ts
function librarySearcher(ctx) {
  return async (bookId, queries) => {
    const usable = queries.map((query) => query.trim()).filter((query) => query.length > 0).slice(0, 12);
    if (usable.length === 0)
      return [];
    try {
      const hits = await ctx.domains.library.queries.books.searchText({ bookId, queries: usable, limit: 5 });
      return hits.map((hit) => ({
        chapterTitle: hit.chapterTitle ?? "",
        snippet: hit.snippet,
        exact: hit.match === "exact"
      }));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      console.warn("annotation-sync quote search failed", code);
      return "unavailable";
    }
  };
}
async function localBooks(ctx) {
  const books = await ctx.domains.library.queries.books.list();
  return books.map((book) => ({ id: book.id, title: book.title, author: book.author }));
}
async function persist(ctx, placed) {
  await replaceGroup(ctx.services.storage, placed.source, placed.excerpts);
}
function summarize(results) {
  const excerpts = results.reduce((sum, result) => sum + result.excerpts.length, 0);
  return {
    ok: true,
    books: results.length,
    excerpts,
    anchored: results.reduce((sum, result) => sum + result.source.anchored, 0),
    unanchored: results.reduce((sum, result) => sum + result.source.unanchored, 0),
    bookmarks: results.reduce((sum, result) => sum + (result.source.bookmarkCount ?? 0), 0),
    quoteSearchTruncated: results.some((result) => result.quoteSearchTruncated)
  };
}
async function syncWereadBooks(ctx, bookId) {
  const apiKey = readWereadApiKey(await ctx.services.secrets.get("api-key"));
  if (!apiKey) {
    return {
      ok: false,
      code: "missing-key",
      message: "Add a WeChat Reading API key (wrk-…) in the plugin settings before syncing."
    };
  }
  const fetchFn = (url, init) => ctx.services.network.fetch(url, init);
  const notebooks = await listWereadNotebooks(fetchFn, apiKey);
  if (!notebooks.ok)
    return notebooks;
  const selected = bookId ? notebooks.data.filter((book) => book.bookId === bookId) : notebooks.data;
  const targets = bookId && selected.length === 0 ? [{ bookId, title: bookId, author: "", reviewCount: 0, noteCount: 0, bookmarkCount: 0, sort: null }] : selected;
  if (bookId && targets.length === 0) {
    return { ok: false, code: "empty-import", message: "That WeChat Reading book has no notebook entry." };
  }
  const books = await localBooks(ctx);
  const links = await readLinks(ctx.services.storage);
  const search = librarySearcher(ctx);
  const placed = [];
  let budget = 120;
  for (const notebook of targets.slice(0, 80)) {
    const exported = await exportWereadBook(fetchFn, apiKey, notebook.bookId, notebook.bookmarkCount);
    if (!exported.ok)
      return exported;
    const group = groupId("weread", notebook.bookId);
    const result = await placeExcerpts({
      source: "weread",
      sourceBookId: notebook.bookId,
      title: exported.data.title || notebook.title,
      author: exported.data.author || notebook.author,
      bookmarkCount: notebook.bookmarkCount,
      excerpts: exported.data.excerpts,
      books,
      forcedBookId: links[group] ?? null,
      search,
      quoteBudget: budget
    });
    budget = Math.max(0, budget - result.quoteSearches);
    await persist(ctx, result);
    placed.push(result);
  }
  await refreshStatus(ctx.services.storage, null);
  return summarize(placed);
}
async function sha(parts) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\x1F")));
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function importParsedExport(ctx, filename, text) {
  const parsed = parseAnnotationExport(filename, text);
  if (!parsed)
    return { ok: false, code: "empty-import", message: `No annotations were found in ${filename}.` };
  const sourceBookId = await sha([parsed.title, parsed.author]);
  const group = groupId("neoreader", sourceBookId);
  const excerpts = await Promise.all(parsed.annotations.map(async (annotation) => ({
    id: `neoreader:${await sha([parsed.title, annotation.chapter, annotation.quote, annotation.note])}`,
    source: "neoreader",
    sourceBookId,
    kind: annotation.quote ? "highlight" : "thought",
    quote: annotation.quote.slice(0, 4000),
    note: annotation.note.slice(0, 4000),
    sourceTitle: parsed.title,
    sourceAuthor: parsed.author,
    sourceChapter: annotation.chapter,
    pageLabel: annotation.pageLabel,
    createdAt: annotation.createdAt
  })));
  const books = await localBooks(ctx);
  const links = await readLinks(ctx.services.storage);
  const result = await placeExcerpts({
    source: "neoreader",
    sourceBookId,
    title: parsed.title,
    author: parsed.author,
    bookmarkCount: null,
    excerpts,
    books,
    forcedBookId: links[group] ?? null,
    search: librarySearcher(ctx)
  });
  await persist(ctx, result);
  await refreshStatus(ctx.services.storage, null);
  return summarize([result]);
}
async function readResourceText(ctx, id, size) {
  const cap = Math.min(size, 2 * 1024 * 1024);
  const chunks = [];
  let offset = 0;
  while (offset < cap) {
    const chunk = await ctx.services.resources.read(id, offset, Math.min(1024 * 1024, cap - offset));
    chunks.push(new Uint8Array(chunk.data));
    offset = chunk.nextOffset;
    if (chunk.eof || chunk.data.byteLength === 0)
      break;
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}
async function importPickedFiles(ctx) {
  const picked = await ctx.services.resources.pick({
    multiple: true,
    extensions: ["txt", "html", "htm", "md", "markdown"]
  });
  if (picked.cancelled || picked.resources.length === 0) {
    return { ok: false, code: "cancelled", message: "Import cancelled." };
  }
  return importResources(ctx, picked.resources);
}
async function importPickedFolder(ctx) {
  const picked = await ctx.services.resources.pickDirectory();
  if (picked.cancelled || !picked.directory)
    return { ok: false, code: "cancelled", message: "Import cancelled." };
  const resources = [];
  let cursor;
  try {
    for (let page = 0;page < 20 && resources.length < 40; page += 1) {
      const listing = await ctx.services.resources.listDirectory(picked.directory.id, {
        limit: 100,
        ...cursor ? { cursor } : {}
      });
      for (const entry of listing.entries) {
        if (entry.kind !== "file" || !/\.(txt|html|htm|md|markdown)$/i.test(entry.name))
          continue;
        const opened = await ctx.services.resources.openDirectoryFile(picked.directory.id, entry.relativePath);
        resources.push(opened);
        if (resources.length >= 40)
          break;
      }
      if (!listing.nextCursor)
        break;
      cursor = listing.nextCursor;
    }
  } finally {
    await ctx.services.resources.releaseDirectory(picked.directory.id);
  }
  if (resources.length === 0) {
    return {
      ok: false,
      code: "empty-import",
      message: "That folder has no txt, html, or markdown annotation exports."
    };
  }
  return importResources(ctx, resources);
}
async function importResources(ctx, resources) {
  const reports = [];
  try {
    for (const resource of resources) {
      const text = await readResourceText(ctx, resource.id, resource.size);
      reports.push(await importParsedExport(ctx, resource.name, text));
    }
  } finally {
    for (const resource of resources) {
      await ctx.services.resources.release(resource.id);
    }
  }
  const failed = reports.find((report) => !report.ok && report.code !== "empty-import");
  if (failed && !failed.ok)
    return failed;
  const imported = reports.filter((report) => report.ok);
  if (imported.length === 0) {
    return { ok: false, code: "empty-import", message: "No annotations were found in the selected files." };
  }
  return imported.reduce((sum, report) => {
    if (!sum.ok || !report.ok)
      return sum;
    return {
      ok: true,
      books: sum.books + report.books,
      excerpts: sum.excerpts + report.excerpts,
      anchored: sum.anchored + report.anchored,
      unanchored: sum.unanchored + report.unanchored,
      bookmarks: 0,
      quoteSearchTruncated: sum.quoteSearchTruncated || report.quoteSearchTruncated
    };
  }, { ok: true, books: 0, excerpts: 0, anchored: 0, unanchored: 0, bookmarks: 0, quoteSearchTruncated: false });
}
async function rematchGroup(ctx, group) {
  const documents = await listDocuments(ctx.services.storage, EXCERPT_COLLECTION);
  const stored = documents.map((document) => document.data).filter((excerpt) => excerpt.group === group);
  const sourceDocument = await ctx.services.storage.collection(SOURCE_COLLECTION).get(group);
  if (!sourceDocument || stored.length === 0) {
    return { ok: false, code: "empty-import", message: "That imported book has no annotations to match again." };
  }
  const source = sourceDocument.data;
  const links = await readLinks(ctx.services.storage);
  const result = await placeExcerpts({
    source: source.source,
    sourceBookId: source.sourceBookId,
    title: source.title,
    author: source.author,
    bookmarkCount: source.bookmarkCount,
    excerpts: stored.map((excerpt) => ({
      id: excerpt.id,
      source: excerpt.source,
      sourceBookId: excerpt.sourceBookId,
      kind: excerpt.kind,
      quote: excerpt.quote,
      note: excerpt.note,
      sourceTitle: excerpt.sourceTitle,
      sourceAuthor: excerpt.sourceAuthor,
      sourceChapter: excerpt.sourceChapter,
      pageLabel: excerpt.pageLabel,
      createdAt: excerpt.createdAt
    })),
    books: await localBooks(ctx),
    forcedBookId: links[group] ?? null,
    search: librarySearcher(ctx)
  });
  await persist(ctx, result);
  await refreshStatus(ctx.services.storage, null);
  return summarize([result]);
}
function searchStoredExcerpts(excerpts, query, limit) {
  const needle = query.trim().toLowerCase();
  return excerpts.filter((excerpt) => {
    if (!needle)
      return true;
    return `${excerpt.quote}
${excerpt.note}
${excerpt.sourceTitle}
${excerpt.sourceChapter}
${excerpt.localTitle ?? ""}`.toLowerCase().includes(needle);
  }).slice(0, limit);
}

// src/agent.ts
var invalid = () => {
  throw Object.assign(new Error("Invalid annotation tool input"), { code: "plugin/invalid-input" });
};
function text(value, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return invalid();
  return value.trim();
}
async function loadExcerpts(ctx, bookId) {
  if (!bookId) {
    const documents = await listDocuments(ctx.services.storage, EXCERPT_COLLECTION);
    return documents.map((document) => document.data);
  }
  const excerpts = [];
  let cursor;
  const collection = ctx.services.storage.collection(EXCERPT_COLLECTION);
  for (let page = 0;page < 20; page += 1) {
    const result = await collection.page({ limit: 200, bookId, ...cursor ? { cursor } : {} });
    if (result.status !== "ready")
      break;
    excerpts.push(...result.items.map((item) => item.data));
    if (!result.nextCursor)
      break;
    cursor = result.nextCursor;
  }
  return excerpts;
}
function registerAgentContributions(ctx) {
  ctx.contributions.agentTools.register({
    name: "list_imported_annotations",
    label: "Imported annotations",
    contexts: ["book", "global"],
    description: "List highlights and notes imported from WeChat Reading or a NeoReader export. Pass bookId to limit results to excerpts linked to that local ReadAware book, including unanchored excerpts whose source title matched. Omit bookId to search the whole import. Query is a case-insensitive substring of the quote, note, source title, or chapter. Anchored means the quote was found in the local book text; unanchored means it was kept as an excerpt because the edition differed or the text was not searchable. Bookmark bodies are never imported. This does not sync or call WeChat Reading.",
    parameters: {
      type: "object",
      properties: {
        bookId: { type: "string", minLength: 1, maxLength: 128 },
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    },
    execute: async (params) => {
      const keys = Object.keys(params);
      if (keys.some((key) => !["bookId", "query", "limit"].includes(key)))
        return invalid();
      const limit = params.limit ?? 8;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20)
        return invalid();
      const query = params.query === undefined ? "" : text(params.query, 200);
      const bookId = params.bookId === undefined ? undefined : text(params.bookId, 128);
      const scoped = bookId ? await loadExcerpts(ctx, bookId) : await loadExcerpts(ctx);
      const items = searchStoredExcerpts(scoped, query, limit);
      return {
        total: scoped.length,
        items: items.map((excerpt) => ({
          id: excerpt.id,
          source: excerpt.source,
          kind: excerpt.kind,
          anchor: excerpt.anchor,
          sourceTitle: excerpt.sourceTitle,
          sourceAuthor: excerpt.sourceAuthor,
          sourceChapter: excerpt.sourceChapter,
          pageLabel: excerpt.pageLabel,
          localBookId: excerpt.localBookId,
          quote: excerpt.quote.slice(0, 800),
          note: excerpt.note.slice(0, 800)
        }))
      };
    }
  });
  ctx.contributions.agentRetrievalProviders.register({
    id: "imported-annotations",
    label: "Imported annotations",
    description: "Search highlights and notes imported from WeChat Reading or NeoReader. In a book conversation, results are limited to excerpts linked to that book.",
    contexts: ["book", "global"],
    retrieve: async ({ scope, query, limit }) => {
      const scoped = scope.kind === "book" ? await loadExcerpts(ctx, scope.bookId) : await loadExcerpts(ctx);
      return retrievalItems(searchStoredExcerpts(scoped, query, Math.min(20, Math.max(1, limit))));
    }
  });
  ctx.contributions.agentContextProviders.register({
    id: "imported-annotations",
    contexts: ["book"],
    provide: async ({ scope }) => {
      if (scope.kind !== "book")
        return [];
      return contextBlocksForBook(scope.bookId, await loadExcerpts(ctx, scope.bookId));
    }
  });
}

// src/views.ts
function copy(locale, en, hans, hant) {
  if (locale === "zh-Hant")
    return hant;
  if (locale.startsWith("zh"))
    return hans;
  return en;
}
function reportText(locale, report) {
  if (!report.ok) {
    if (report.code === "missing-key") {
      return copy(locale, "Add a WeChat Reading API key (wrk-…) in the plugin settings before syncing.", "同步前，请先在插件设置里填写微信读书 API Key（wrk-…）。", "同步前，請先在外掛設定裡填寫微信讀書 API Key（wrk-…）。");
    }
    if (report.code === "unauthorized") {
      return copy(locale, "WeChat Reading rejected the API key.", "微信读书拒绝了这个 API Key。", "微信讀書拒絕了這個 API Key。");
    }
    if (report.code === "network") {
      return copy(locale, "WeChat Reading could not be reached.", "无法连接微信读书。", "無法連接微信讀書。");
    }
    return report.message;
  }
  const truncated = report.quoteSearchTruncated ? copy(locale, " Quote search stopped early; remaining passages stay unanchored.", " 引文检索提前停止，其余条目保持未锚定。", " 引文檢索提前停止，其餘條目保持未錨定。") : "";
  return copy(locale, `Imported ${report.excerpts} annotations from ${report.books} book(s): ${report.anchored} anchored, ${report.unanchored} unanchored. Bookmarks are count-only (${report.bookmarks}).`, `已从 ${report.books} 本书导入 ${report.excerpts} 条标注：${report.anchored} 条已锚定，${report.unanchored} 条未锚定。书签只计数量（${report.bookmarks}）。`, `已從 ${report.books} 本書匯入 ${report.excerpts} 則標註：${report.anchored} 則已錨定，${report.unanchored} 則未錨定。書籤只計數量（${report.bookmarks}）。`) + truncated;
}
async function finish(ctx, report) {
  if (!report.ok && report.code === "cancelled")
    return null;
  return {
    toast: reportText(ctx.locale, report),
    view: await annotationPage(ctx),
    navigation: "replace"
  };
}
async function annotationPage(ctx) {
  const locale = ctx.locale;
  const status = readStatus(ctx.services.storage);
  const sources = await listDocuments(ctx.services.storage, SOURCE_COLLECTION);
  return {
    kind: "blocks",
    title: "Annotation Sync",
    blocks: [
      {
        kind: "text",
        tone: "muted",
        text: copy(locale, "Import WeChat Reading highlights and thoughts, or a NeoReader txt/html/markdown export. The agent reads them as context. Bookmark text is not available from WeChat Reading.", "导入微信读书划线和想法，或 NeoReader 的 txt/html/markdown 导出。助手会把它们当作上下文。微信读书不提供书签正文。", "匯入微信讀書畫線和想法，或 NeoReader 的 txt/html/markdown 匯出。助手會把它們當作上下文。微信讀書不提供書籤正文。")
      },
      {
        kind: "keyValue",
        rows: [
          { label: copy(locale, "Annotations", "标注", "標註"), value: String(status.excerpts) },
          { label: copy(locale, "Anchored", "已锚定", "已錨定"), value: String(status.anchored) },
          { label: copy(locale, "Unanchored", "未锚定", "未錨定"), value: String(status.unanchored) }
        ]
      },
      {
        kind: "actions",
        actions: [
          {
            id: "sync-all",
            label: copy(locale, "Sync WeChat Reading", "同步微信读书", "同步微信讀書"),
            icon: "arrows-clockwise",
            priority: "primary",
            run: () => syncWereadBooks(ctx).then((report) => finish(ctx, report))
          },
          {
            id: "sync-one",
            label: copy(locale, "Sync one book", "同步一本书", "同步一本書"),
            icon: "book-open",
            priority: "primary",
            run: () => ({ view: syncOneView(ctx) })
          },
          {
            id: "import-files",
            label: copy(locale, "Import NeoReader files", "导入 NeoReader 文件", "匯入 NeoReader 檔案"),
            icon: "file-text",
            run: () => importPickedFiles(ctx).then((report) => finish(ctx, report))
          },
          {
            id: "import-folder",
            label: copy(locale, "Import NeoReader folder", "导入 NeoReader 文件夹", "匯入 NeoReader 資料夾"),
            icon: "folder",
            run: () => importPickedFolder(ctx).then((report) => finish(ctx, report))
          }
        ]
      },
      {
        kind: "list",
        title: copy(locale, "Imported books", "已导入的书", "已匯入的書"),
        emptyText: copy(locale, "Nothing imported yet.", "还没有导入。", "還沒有匯入。"),
        searchable: true,
        items: sources.map((document) => ({
          id: document.id,
          title: document.data.title,
          subtitle: copy(locale, `${document.data.anchored} anchored · ${document.data.unanchored} unanchored${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`, `${document.data.anchored} 条已锚定 · ${document.data.unanchored} 条未锚定${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`, `${document.data.anchored} 則已錨定 · ${document.data.unanchored} 則未錨定${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`),
          icon: document.data.source === "weread" ? "book-bookmark" : "file-text",
          accessories: document.data.bookmarkCount === null ? [] : [{ kind: "text", text: `${document.data.bookmarkCount} bookmarks` }],
          onSelect: () => bookDetail(ctx, document.data)
        }))
      }
    ]
  };
}
function syncOneView(ctx) {
  const locale = ctx.locale;
  return {
    kind: "form",
    title: copy(locale, "Sync one WeChat Reading book", "同步一本微信读书", "同步一本微信讀書"),
    submitLabel: copy(locale, "Sync", "同步", "同步"),
    fields: [
      {
        kind: "text",
        id: "bookId",
        label: copy(locale, "WeChat Reading book ID", "微信读书 bookId", "微信讀書 bookId"),
        placeholder: "822995",
        helperText: copy(locale, "The bookId from a notebook row. Highlights and thoughts are fetched; bookmark text is skipped.", "笔记本里的 bookId。会拉取划线和想法，不拉取书签正文。", "筆記本裡的 bookId。會拉取畫線和想法，不拉取書籤正文。")
      }
    ],
    onSubmit: async (values) => {
      const bookId = typeof values.bookId === "string" ? values.bookId.trim() : "";
      if (!bookId) {
        return {
          fieldErrors: {
            bookId: copy(locale, "Enter a book ID.", "请填写 bookId。", "請填寫 bookId。")
          }
        };
      }
      return finish(ctx, await syncWereadBooks(ctx, bookId));
    }
  };
}
async function bookDetail(ctx, source) {
  const locale = ctx.locale;
  const books = await ctx.domains.library.queries.books.list();
  return {
    view: {
      kind: "form",
      title: source.title,
      submitLabel: copy(locale, "Match again", "重新匹配", "重新配對"),
      fields: [
        {
          kind: "select",
          id: "localBookId",
          label: copy(locale, "Local book", "本地书籍", "本地書籍"),
          value: source.localBookId ?? "auto",
          helperText: copy(locale, "Automatic uses the title. Pick a book when the edition or translation title differs, then match again. Quotes that are not found stay unanchored.", "自动按书名匹配。译本或不同版本书名不一致时，指定本地书再重新匹配。找不到的引文会保持未锚定。", "自動按書名配對。譯本或不同版本書名不一致時，指定本地書再重新配對。找不到的引文會保持未錨定。"),
          options: [
            { value: "auto", label: copy(locale, "Automatic title match", "按书名自动匹配", "按書名自動配對") },
            ...books.slice(0, 300).map((book) => ({ value: book.id, label: book.title }))
          ]
        }
      ],
      onSubmit: async (values) => {
        const selected = typeof values.localBookId === "string" ? values.localBookId : "auto";
        await writeLink(ctx.services.storage, source.group, selected && selected !== "auto" ? selected : null);
        return finish(ctx, await rematchGroup(ctx, source.group));
      }
    }
  };
}
function activateAnnotationSync(ctx) {
  if (!ctx.domains.library || !ctx.services.network)
    return;
  const ready = ctx;
  ctx.contributions.headerActions.register({
    id: "annotation-sync",
    title: "Annotation Sync",
    icon: "highlighter",
    surface: "shelf",
    presentation: "page",
    view: () => annotationPage(ready)
  });
  ctx.contributions.commands.register({
    id: "open",
    title: "Annotation Sync: imported notes",
    icon: "highlighter",
    keywords: "weread wechat reading neoreader highlights annotations",
    run: async () => ({ view: await annotationPage(ready) })
  });
  if (ready.contributions.agentTools && ready.contributions.agentContextProviders && ready.contributions.agentRetrievalProviders) {
    registerAgentContributions(ready);
  }
}

// src/index.ts
var plugin = {
  activate(ctx) {
    assertPluginCapabilities(ctx);
    activateAnnotationSync(ctx);
  }
};
var src_default = plugin;
export {
  src_default as default
};
