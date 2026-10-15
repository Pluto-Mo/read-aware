package com.readaware.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StrictMode
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileInputStream

/**
 * Hands a local book to BOOX NeoReader.
 *
 * There is no embeddable Readware SDK in the public Onyx demo. NeoReader is a
 * separate app (`com.onyx.kreader`) that opens a world-readable `file://` path.
 * The desktop associated-app opener copies into a private cache NeoReader cannot
 * read, so this writes Download/ReadAware through MediaStore instead. Switching
 * NeoReader's own V2/V3 engine closes *its* document; that engine is not
 * something this activity can host.
 *
 * No-op off Onyx. The callback receives a status the web layer can show.
 */
object OnyxSystemReader {
  private const val TAG = "ReadAwareEngine"
  const val NEO_PACKAGE = "com.onyx.kreader"
  const val NEO_ACTIVITY = "com.onyx.kreader.ui.ReaderHomeActivity"
  private const val RELATIVE_PATH = "Download/ReadAware"

  /** "started" once a background copy is queued, otherwise a terminal status. */
  fun begin(
    activity: Activity,
    sourcePath: String,
    displayName: String,
    mime: String,
    onStatus: (String) -> Unit,
  ): String {
    if (!OnyxEink.isDevice) return "skipped"
    val source = File(sourcePath)
    if (!source.isFile || source.length() <= 0L) return "missing"
    val app = activity.applicationContext
    Thread {
      try {
        val shared = writePublicBook(app, source, displayName, mime)
        if (shared == null) {
          activity.runOnUiThread { onStatus("missing") }
          return@Thread
        }
        activity.runOnUiThread {
          onStatus(startNeoReader(activity, shared, mime.ifBlank { mimeForName(displayName) }))
        }
      } catch (error: Throwable) {
        Log.w(TAG, "handoff failed: ${error.javaClass.simpleName}: ${error.message}")
        val status = "error:${error.javaClass.simpleName}"
        activity.runOnUiThread { onStatus(status) }
      }
    }.apply {
      name = "readaware-system-reader"
      isDaemon = true
      start()
    }
    return "started"
  }

  internal fun shareFileName(displayName: String, mime: String): String {
    val cleaned = displayName
      .trim()
      .replace(Regex("""[\u0000-\u001f\\/:*?"<>|]"""), "_")
      .trim(' ', '.')
      .take(120)
      .trim(' ', '.')
    val named = if (cleaned.isEmpty()) "book" else cleaned
    if (named.contains('.')) return named
    val ext = extensionForMime(mime)
    return if (ext.isEmpty()) named else "$named.$ext"
  }

  internal fun extensionForMime(mime: String): String = when (mime.substringBefore(';').trim().lowercase()) {
    "application/epub+zip" -> "epub"
    "application/pdf" -> "pdf"
    "application/x-mobipocket-ebook" -> "mobi"
    "application/vnd.amazon.ebook" -> "azw3"
    "application/x-fictionbook+xml" -> "fb2"
    "application/vnd.comicbook+zip" -> "cbz"
    "application/vnd.comicbook-rar" -> "cbr"
    "text/plain" -> "txt"
    "text/html" -> "html"
    else -> ""
  }

  private fun mimeForName(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "epub" -> "application/epub+zip"
    "pdf" -> "application/pdf"
    "mobi", "prc" -> "application/x-mobipocket-ebook"
    "azw", "azw3", "kf8" -> "application/vnd.amazon.ebook"
    "fb2", "fbz" -> "application/x-fictionbook+xml"
    "cbz" -> "application/vnd.comicbook+zip"
    "cbr" -> "application/vnd.comicbook-rar"
    "txt", "text" -> "text/plain"
    "html", "htm", "xhtml" -> "text/html"
    else -> "application/octet-stream"
  }

  private fun writePublicBook(context: Context, source: File, displayName: String, mime: String): File? {
    val name = shareFileName(displayName, mime)
    val type = mime.ifBlank { mimeForName(name) }.ifBlank { "application/octet-stream" }
    val resolver = context.contentResolver
    val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Downloads.EXTERNAL_CONTENT_URI
    } else {
      MediaStore.Files.getContentUri("external")
    }
    resolver.delete(collection, "${MediaStore.MediaColumns.DISPLAY_NAME}=?", arrayOf(name))
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, type)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      } else {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ReadAware")
        if (!dir.exists() && !dir.mkdirs()) return null
        put(MediaStore.MediaColumns.DATA, File(dir, name).absolutePath)
      }
    }
    val uri = resolver.insert(collection, values) ?: return null
    try {
      resolver.openOutputStream(uri)?.use { out ->
        FileInputStream(source).use { input -> input.copyTo(out) }
      } ?: return null
    } catch (error: Throwable) {
      resolver.delete(uri, null, null)
      throw error
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val ready = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      resolver.update(uri, ready, null, null)
    }
    val fromStore = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
    }
    val path = fromStore?.takeIf { it.isNotEmpty() }
      ?: File(Environment.getExternalStorageDirectory(), "$RELATIVE_PATH/$name").absolutePath
    val file = File(path)
    if (!file.isFile) return null
    file.setReadable(true, false)
    Log.i(TAG, "shared ${file.length()} bytes as $path")
    return file
  }

  private fun startNeoReader(activity: Activity, file: File, mime: String): String {
    // NeoReader resolves file:// paths. A content URI grant is not enough on
    // current BOOX builds. The method is hidden from newer SDK stubs but
    // present on device; a miss just leaves the platform check in place.
    try {
      StrictMode::class.java.getMethod("disableDeathOnFileUriExposure").invoke(null)
    } catch (_: Throwable) {
      // FileUriExposedException is reported by the start attempt below.
    }
    val uri = Uri.fromFile(file)
    val type = mime.ifBlank { "application/octet-stream" }
    val attempts = listOf(
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, type)
        setClassName(NEO_PACKAGE, NEO_ACTIVITY)
      },
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, type)
        setPackage(NEO_PACKAGE)
      },
    )
    for (intent in attempts) {
      try {
        activity.startActivity(intent)
        Log.i(TAG, "opened ${intent.component ?: intent.`package`}")
        return "opened"
      } catch (_: ActivityNotFoundException) {
        continue
      } catch (error: Throwable) {
        Log.w(TAG, "start failed: ${error.javaClass.simpleName}: ${error.message}")
      }
    }
    return "unavailable"
  }
}
