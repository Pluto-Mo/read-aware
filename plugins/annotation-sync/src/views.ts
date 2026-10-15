import type { PluginContext, PluginView, PluginViewResult } from "@read-aware/plugin-types";
import { registerAgentContributions } from "./agent";
import { listDocuments, readStatus, writeLink } from "./store";
import { importPickedFiles, importPickedFolder, rematchGroup, syncWereadBooks, type SyncReport } from "./sync";
import { SOURCE_COLLECTION, type AnnotationSyncContext, type StoredSourceBook } from "./types";

function copy(locale: string, en: string, hans: string, hant: string): string {
  if (locale === "zh-Hant") return hant;
  if (locale.startsWith("zh")) return hans;
  return en;
}

function reportText(locale: string, report: SyncReport): string {
  if (!report.ok) {
    if (report.code === "missing-key") {
      return copy(
        locale,
        "Add a WeChat Reading API key (wrk-…) in the plugin settings before syncing.",
        "同步前，请先在插件设置里填写微信读书 API Key（wrk-…）。",
        "同步前，請先在外掛設定裡填寫微信讀書 API Key（wrk-…）。",
      );
    }
    if (report.code === "unauthorized") {
      return copy(
        locale,
        "WeChat Reading rejected the API key.",
        "微信读书拒绝了这个 API Key。",
        "微信讀書拒絕了這個 API Key。",
      );
    }
    if (report.code === "network") {
      return copy(locale, "WeChat Reading could not be reached.", "无法连接微信读书。", "無法連接微信讀書。");
    }
    return report.message;
  }
  const truncated = report.quoteSearchTruncated
    ? copy(
        locale,
        " Quote search stopped early; remaining passages stay unanchored.",
        " 引文检索提前停止，其余条目保持未锚定。",
        " 引文檢索提前停止，其餘條目保持未錨定。",
      )
    : "";
  return (
    copy(
      locale,
      `Imported ${report.excerpts} annotations from ${report.books} book(s): ${report.anchored} anchored, ${report.unanchored} unanchored. Bookmarks are count-only (${report.bookmarks}).`,
      `已从 ${report.books} 本书导入 ${report.excerpts} 条标注：${report.anchored} 条已锚定，${report.unanchored} 条未锚定。书签只计数量（${report.bookmarks}）。`,
      `已從 ${report.books} 本書匯入 ${report.excerpts} 則標註：${report.anchored} 則已錨定，${report.unanchored} 則未錨定。書籤只計數量（${report.bookmarks}）。`,
    ) + truncated
  );
}

async function finish(ctx: AnnotationSyncContext, report: SyncReport): Promise<PluginViewResult> {
  if (!report.ok && report.code === "cancelled") return null;
  return {
    toast: reportText(ctx.locale, report),
    view: await annotationPage(ctx),
    navigation: "replace",
  };
}

export async function annotationPage(ctx: AnnotationSyncContext): Promise<PluginView> {
  const locale = ctx.locale;
  const status = readStatus(ctx.services.storage);
  const sources = await listDocuments<StoredSourceBook>(ctx.services.storage, SOURCE_COLLECTION);
  return {
    kind: "blocks",
    title: "Annotation Sync",
    blocks: [
      {
        kind: "text",
        tone: "muted",
        text: copy(
          locale,
          "Import WeChat Reading highlights and thoughts, or a NeoReader txt/html/markdown export. The agent reads them as context. Bookmark text is not available from WeChat Reading.",
          "导入微信读书划线和想法，或 NeoReader 的 txt/html/markdown 导出。助手会把它们当作上下文。微信读书不提供书签正文。",
          "匯入微信讀書畫線和想法，或 NeoReader 的 txt/html/markdown 匯出。助手會把它們當作上下文。微信讀書不提供書籤正文。",
        ),
      },
      {
        kind: "keyValue",
        rows: [
          { label: copy(locale, "Annotations", "标注", "標註"), value: String(status.excerpts) },
          { label: copy(locale, "Anchored", "已锚定", "已錨定"), value: String(status.anchored) },
          { label: copy(locale, "Unanchored", "未锚定", "未錨定"), value: String(status.unanchored) },
        ],
      },
      {
        kind: "actions",
        actions: [
          {
            id: "sync-all",
            label: copy(locale, "Sync WeChat Reading", "同步微信读书", "同步微信讀書"),
            icon: "arrows-clockwise",
            priority: "primary",
            run: () => syncWereadBooks(ctx).then((report) => finish(ctx, report)),
          },
          {
            id: "sync-one",
            label: copy(locale, "Sync one book", "同步一本书", "同步一本書"),
            icon: "book-open",
            priority: "primary",
            run: () => ({ view: syncOneView(ctx) }),
          },
          {
            id: "import-files",
            label: copy(locale, "Import NeoReader files", "导入 NeoReader 文件", "匯入 NeoReader 檔案"),
            icon: "file-text",
            run: () => importPickedFiles(ctx).then((report) => finish(ctx, report)),
          },
          {
            id: "import-folder",
            label: copy(locale, "Import NeoReader folder", "导入 NeoReader 文件夹", "匯入 NeoReader 資料夾"),
            icon: "folder",
            run: () => importPickedFolder(ctx).then((report) => finish(ctx, report)),
          },
        ],
      },
      {
        kind: "list",
        title: copy(locale, "Imported books", "已导入的书", "已匯入的書"),
        emptyText: copy(locale, "Nothing imported yet.", "还没有导入。", "還沒有匯入。"),
        searchable: true,
        items: sources.map((document) => ({
          id: document.id,
          title: document.data.title,
          subtitle: copy(
            locale,
            `${document.data.anchored} anchored · ${document.data.unanchored} unanchored${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`,
            `${document.data.anchored} 条已锚定 · ${document.data.unanchored} 条未锚定${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`,
            `${document.data.anchored} 則已錨定 · ${document.data.unanchored} 則未錨定${document.data.localTitle ? ` · ${document.data.localTitle}` : ""}`,
          ),
          icon: document.data.source === "weread" ? "book-bookmark" : "file-text",
          accessories:
            document.data.bookmarkCount === null
              ? []
              : [{ kind: "text" as const, text: `${document.data.bookmarkCount} bookmarks` }],
          onSelect: () => bookDetail(ctx, document.data),
        })),
      },
    ],
  };
}

function syncOneView(ctx: AnnotationSyncContext): PluginView {
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
        helperText: copy(
          locale,
          "The bookId from a notebook row. Highlights and thoughts are fetched; bookmark text is skipped.",
          "笔记本里的 bookId。会拉取划线和想法，不拉取书签正文。",
          "筆記本裡的 bookId。會拉取畫線和想法，不拉取書籤正文。",
        ),
      },
    ],
    onSubmit: async (values) => {
      const bookId = typeof values.bookId === "string" ? values.bookId.trim() : "";
      if (!bookId) {
        return {
          fieldErrors: {
            bookId: copy(locale, "Enter a book ID.", "请填写 bookId。", "請填寫 bookId。"),
          },
        };
      }
      return finish(ctx, await syncWereadBooks(ctx, bookId));
    },
  };
}

async function bookDetail(ctx: AnnotationSyncContext, source: StoredSourceBook): Promise<PluginViewResult> {
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
          helperText: copy(
            locale,
            "Automatic uses the title. Pick a book when the edition or translation title differs, then match again. Quotes that are not found stay unanchored.",
            "自动按书名匹配。译本或不同版本书名不一致时，指定本地书再重新匹配。找不到的引文会保持未锚定。",
            "自動按書名配對。譯本或不同版本書名不一致時，指定本地書再重新配對。找不到的引文會保持未錨定。",
          ),
          options: [
            { value: "auto", label: copy(locale, "Automatic title match", "按书名自动匹配", "按書名自動配對") },
            ...books.slice(0, 300).map((book) => ({ value: book.id, label: book.title })),
          ],
        },
      ],
      onSubmit: async (values) => {
        const selected = typeof values.localBookId === "string" ? values.localBookId : "auto";
        await writeLink(ctx.services.storage, source.group, selected && selected !== "auto" ? selected : null);
        return finish(ctx, await rematchGroup(ctx, source.group));
      },
    },
  };
}

export function activateAnnotationSync(ctx: PluginContext): void {
  if (!ctx.domains.library || !ctx.services.network) return;
  const ready = ctx as AnnotationSyncContext;
  ctx.contributions.headerActions.register({
    id: "annotation-sync",
    title: "Annotation Sync",
    icon: "highlighter",
    surface: "shelf",
    presentation: "page",
    view: () => annotationPage(ready),
  });
  ctx.contributions.commands.register({
    id: "open",
    title: "Annotation Sync: imported notes",
    icon: "highlighter",
    keywords: "weread wechat reading neoreader highlights annotations",
    run: async () => ({ view: await annotationPage(ready) }),
  });
  if (
    ready.contributions.agentTools &&
    ready.contributions.agentContextProviders &&
    ready.contributions.agentRetrievalProviders
  ) {
    registerAgentContributions(ready);
  }
}
