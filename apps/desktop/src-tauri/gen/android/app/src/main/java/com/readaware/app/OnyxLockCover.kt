package com.readaware.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/**
 * BOOX standby image (锁屏封面) for the book that is open.
 *
 * `ScreenResourceManager.setScreensaver` on API 28+ (Onyx SDK 1.3.6) sends
 * `onyx.action.SCREENSAVER` with `type` 16 (`TYPE_SCREENSAVER`), `file` as an
 * absolute path the system can read, and `show_result_hint`. A second
 * `update_standby_pic` broadcast is what the pre-P SDK and readers such as
 * Komga send so a later image replaces the one already captured. This does
 * not touch the home wallpaper (`TYPE_WALLPAPER`) and does not toast
 * (`show_result_hint` false).
 *
 * The standby bitmap is taken when the panel sleeps, so the image is published
 * when a book opens — not on `ACTION_SCREEN_OFF`, which is too late. There is
 * no API to read the previous screensaver, so closing the book leaves the last
 * cover in place rather than blanking it. No-op off Onyx.
 */
object OnyxLockCover {
  private const val TAG = "ReadAwareLock"
  private const val ACTION_SCREENSAVER = "onyx.action.SCREENSAVER"
  private const val ACTION_UPDATE_STANDBY = "update_standby_pic"
  private const val TYPE_SCREENSAVER = 16
  private const val DISPLAY_NAME = "readaware-standby.png"
  private const val RELATIVE_PATH = "Pictures/ReadAware"

  private val generation = AtomicInteger()

  fun publish(context: Context, sourcePath: String, title: String, widthPx: Int, heightPx: Int) {
    if (!OnyxEink.isDevice) return
    if (widthPx < 16 || heightPx < 16) return
    val ticket = generation.incrementAndGet()
    val app = context.applicationContext
    val safeTitle = title.trim().take(120)
    Thread {
      try {
        if (ticket != generation.get()) return@Thread
        val cover = decode(sourcePath)
        val bitmap = compose(cover, safeTitle, widthPx, heightPx)
        cover?.recycle()
        val path = writePublicPng(app, bitmap)
        bitmap.recycle()
        if (ticket != generation.get()) return@Thread
        if (path == null) {
          Log.w(TAG, "standby image was not written")
          return@Thread
        }
        broadcast(app, path)
        Log.i(TAG, "standby published $widthPx x $heightPx path=$path")
      } catch (error: Throwable) {
        Log.w(TAG, "standby publish failed: ${error.javaClass.simpleName}: ${error.message}")
      }
    }.apply {
      name = "readaware-lock-cover"
      isDaemon = true
      start()
    }
  }

  private fun decode(sourcePath: String): Bitmap? {
    if (sourcePath.isEmpty()) return null
    val file = File(sourcePath)
    if (!file.isFile || file.length() <= 0L || file.length() > 8L * 1024 * 1024) return null
    return BitmapFactory.decodeFile(file.absolutePath)
  }

  /** Fit-center the cover on a white panel-sized bitmap. Title when there is no raster. */
  internal fun compose(cover: Bitmap?, title: String, width: Int, height: Int): Bitmap {
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.WHITE)
    if (cover != null && cover.width > 0 && cover.height > 0) {
      val scale = min(width.toFloat() / cover.width, height.toFloat() / cover.height)
      val dw = cover.width * scale
      val dh = cover.height * scale
      val left = (width - dw) / 2f
      val top = (height - dh) / 2f
      val paint = Paint(Paint.FILTER_BITMAP_FLAG)
      canvas.drawBitmap(cover, null, RectF(left, top, left + dw, top + dh), paint)
      return out
    }
    if (title.isNotEmpty()) drawTitle(canvas, title, width, height)
    return out
  }

  private fun drawTitle(canvas: Canvas, title: String, width: Int, height: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      textAlign = Paint.Align.CENTER
      textSize = width * 0.045f
    }
    val maxWidth = width * 0.72f
    val lines = wrap(title, paint, maxWidth).take(6)
    val lineHeight = paint.fontSpacing
    var y = height / 2f - (lines.size - 1) * lineHeight / 2f
    for (line in lines) {
      canvas.drawText(line, width / 2f, y, paint)
      y += lineHeight
    }
  }

  private fun wrap(text: String, paint: Paint, maxWidth: Float): List<String> {
    val words = text.split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return emptyList()
    val lines = mutableListOf<String>()
    var current = words.first()
    for (word in words.drop(1)) {
      val next = "$current $word"
      if (paint.measureText(next) <= maxWidth) current = next
      else {
        lines.add(current)
        current = word
      }
    }
    lines.add(current)
    return lines
  }

  /**
   * Public Pictures via MediaStore. App-specific dirs are not readable by the
   * system process that loads the standby image. Returns the absolute path.
   */
  private fun writePublicPng(context: Context, bitmap: Bitmap): String? {
    val resolver = context.contentResolver
    val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val relative = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) RELATIVE_PATH else Environment.DIRECTORY_PICTURES
    resolver.delete(
      collection,
      "${MediaStore.Images.Media.DISPLAY_NAME}=?",
      arrayOf(DISPLAY_NAME),
    )
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, DISPLAY_NAME)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.Images.Media.RELATIVE_PATH, relative)
        put(MediaStore.Images.Media.IS_PENDING, 1)
      } else {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "ReadAware")
        if (!dir.exists() && !dir.mkdirs()) return null
        put(MediaStore.Images.Media.DATA, File(dir, DISPLAY_NAME).absolutePath)
      }
    }
    val uri = resolver.insert(collection, values) ?: return null
    resolver.openOutputStream(uri)?.use { stream ->
      if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) return null
    } ?: return null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val ready = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
      resolver.update(uri, ready, null, null)
    }
    val fromStore = resolver.query(uri, arrayOf(MediaStore.Images.Media.DATA), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    }
    val path = fromStore?.takeIf { it.isNotEmpty() }
      ?: File(Environment.getExternalStorageDirectory(), "$RELATIVE_PATH/$DISPLAY_NAME").absolutePath
    val file = File(path)
    if (!file.isFile) return null
    file.setReadable(true, false)
    return path
  }

  private fun broadcast(context: Context, path: String) {
    context.sendBroadcast(
      Intent(ACTION_SCREENSAVER).apply {
        putExtra("type", TYPE_SCREENSAVER)
        putExtra("file", path)
        putExtra("show_result_hint", false)
      },
    )
    context.sendBroadcast(Intent(ACTION_UPDATE_STANDBY))
  }
}
