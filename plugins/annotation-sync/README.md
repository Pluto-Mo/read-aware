# Annotation Sync

Annotation Sync is a first-party ReadAware plugin. It imports reading annotations into the plugin's private store and exposes them to the desktop agent as book context, a retrieval source, and the `list_imported_annotations` tool. It does not write host highlights. A WeChat Reading or NeoReader file is often a different edition from the EPUB on the shelf, so source offsets are not copied onto the local book.

The plugin is marketplace-shaped source under `plugins/annotation-sync`. It is not in the release bundled-plugin table. A debug build that serves `plugins/*/dist` can load it after `bun run --filter @read-aware/plugin-annotation-sync build`. Otherwise install the built `dist` folder (manifest plus `main.js`) from Plugins.

## Configure the WeChat Reading key

1. Create a key at [weread.qq.com/r/weread-skills](https://weread.qq.com/r/weread-skills). It looks like `wrk-…`.
2. Open the plugin's settings and paste it into **WeChat Reading API key**. The value is stored with `ctx.services.secrets` under `api-key`. It is not a normal setting and is not sent to the agent.
3. Open **Annotation Sync** from the shelf header or the command palette.

The plugin calls `POST https://i.weread.qq.com/api/agent/gateway` with `Authorization: Bearer <key>`, `skill_version` `1.0.5`, and flat parameters (`api_name` plus the business fields). If the response contains `upgrade_info`, sync stops and shows that message.

## Sync one book

1. In Annotation Sync, choose **Sync one book**.
2. Enter the WeChat Reading `bookId` (the notebook overview uses the same id).
3. The plugin reads `/book/bookmarklist` for 划线 and `/review/list/mine` for 想法 and 点评.
4. Bookmark rows are count-only. `/user/notebooks` `bookmarkCount` is shown on the book, and bookmark bodies are not stored. A `type: 0` row in the highlight list is skipped. A thought whose quoted text matches a highlight is attached as that highlight's note.

**Sync WeChat Reading** walks the notebook list and imports every book, up to 80 books. Quote search across the whole shelf is capped at 120 searches per run; later passages stay unanchored until you sync that book again.

## NeoReader exports

**Import NeoReader files** picks `.txt`, `.html`, `.htm`, `.md`, or `.markdown` exports. **Import NeoReader folder** scans the immediate children of a folder you pick and imports those extensions. The host directory grant is temporary, so this is a one-shot import rather than a background watch.

Recognized shapes:

- NeoReader text: a `<<title>>` or `《title》` first line, a chapter block, the highlighted lines, an optional `笔记：` / `Note:` line, then a `YYYY-MM-DD` line with `Page No.`
- NeoReader HTML: an `h2` title, chapter divs styled at `14pt`, and quote divs with a dotted top border
- Markdown: `# title`, optional `作者：` / `Author:`, `## chapter`, then a blockquote or a `- ` line and an optional note

## How matching works when editions differ

Matching never uses the WeChat Reading book id, an EPUB hash, or a source range as a location in the local file.

1. Local books the plugin is allowed to read are ranked by fuzzy title. Subtitles after `:`, `：`, or `—` can match the shorter title. An author vetoes the pair only when both names are in the same script and dissimilar. A Chinese author and a Latin credit do not veto, but the titles still have to match on their own. `三体` does not automatically match `The Three-Body Problem`.
2. For each highlight, one or two windows of the quote are searched in the title candidates with the host's book text search. A hit is anchored only when the returned snippet actually overlaps the quote. The source chapter title is a tie-break, not a requirement. The stored result is the local book id plus the chapter label from the hit. It is not a host highlight and not a source offset.
3. If the title matches and the quote does not, the excerpt stays on that local book as **unanchored**. The agent can still read it. The context block says the quote was not found in this file.
4. If no local title matches, the excerpt stays in the import with no local book. Global chat and `list_imported_annotations` (without `bookId`) can still retrieve it. Book-scoped chat does not inject it.
5. Open an imported book and choose **Match again** to force a local book, including a translation whose title does not match, then re-run quote search. Choose **Automatic title match** to clear that link.

Quote search needs text ReadAware has already prepared for that book. If search is unavailable, passages stay unanchored and linked by title only. Sync the book again after the local text is ready.

In a book conversation the agent receives a short imported-annotation block for excerpts linked to that book, anchored items first. Retrieval and `list_imported_annotations` answer follow-up questions. They do not call WeChat Reading and they do not see the API key.
