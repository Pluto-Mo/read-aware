package com.readaware.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File

class MainActivity : TauriActivity() {
  override fun attachBaseContext(newBase: Context) {
    // Before the WebView is created, so CSS pixels follow the measured panel.
    super.attachBaseContext(if (OnyxEink.isDevice) OnyxDisplay.wrap(newBase) else newBase)
  }

  companion object {
    /** Classic requestCode for the book picker — distinct from the
     *  ActivityResult launchers Tauri's PluginManager registers. */
    private const val BOOK_PICK_REQUEST = 51733
  }

  /** Generation of the pick currently in flight; 0 = none. */
  @Volatile private var bookPickGeneration = 0

  /** Parked pick result: "<generation>" alone = cancelled, else
   *  "<generation>\n<uri>\t<displayName>\t<size>\n…" — name/size resolved
   *  from the content provider here, where the grant is certain, so the
   *  webview never has to query SAF. The webview collects it by POLLING
   *  (`book_pick_poll` over ordinary request/response IPC) instead of
   *  receiving a push: Tauri's own dialog plugin delivers activity results
   *  through a single mutable callback slot whose response can be dropped
   *  while the webview is paused mid round-trip — a cancel is lost nearly
   *  every time, a successful pick intermittently. Parked state + polling
   *  cannot lose the result. */
  @Volatile private var bookPickResult: String? = null
  /** While true, volume keys step the reader's sentence navigator instead of
   *  changing the volume. Toggled from Rust (`set_volume_key_capture`) as the
   *  navigator mode starts/stops, so media volume works normally otherwise. */
  @Volatile private var volumeKeysCaptured = false
  /** While true, page-turn keys (and, on Onyx, volume and d-pad) turn reader
   *  pages. Toggled from Rust (`set_reader_page_key_capture`) for the lifetime
   *  of the reader, released while a text field is focused. */
  @Volatile private var readerPageKeysCaptured = false
  /** APK waiting for the user to grant this app install-source permission. */
  @Volatile private var pendingUpdateApkPath: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The app draws edge-to-edge, but Android's WebView never surfaces the
    // system-bar/cutout insets through CSS `env(safe-area-inset-*)` the way
    // iOS does — so the web layer's `--ra-safe-*` variables resolve to 0 and
    // fixed chrome (the reader header, most visibly) lays out under the
    // status bar, where its buttons can never receive touches. Bridge the
    // real insets into those variables instead. Attached to the content view
    // (not the decor view) so the window's own insets handling is untouched.
    ViewCompat.setOnApplyWindowInsetsListener(
      findViewById<View>(android.R.id.content)
    ) { view, insets ->
      // Keyboard avoidance: edge-to-edge opts the window out of adjustResize,
      // so the IME just overlays the webview and bottom-anchored inputs (the
      // chat composer, search fields) end up behind it — the webview never
      // learns the keyboard exists. Shrink it ourselves: pad the content view
      // by the IME inset so the app-shell layout reflows above the keyboard.
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(0, 0, 0, ime.bottom)
      applySafeAreaToWebView(insets)
      insets
    }
    // Hand the back button/gesture to the web layer, which unwinds its own
    // navigation one layer at a time (dialogs → reader → shelf surfaces) and
    // calls `move_task_to_back` at the root. The default would finish() the
    // activity — tearing down the whole Tauri process, so every return to the
    // app became a cold start. (TauriActivity opts out of wry's own handler
    // via handleBackNavigation = false; the SPA has no WebView history anyway.)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          // Keep the event name in step with platform/back-navigation.ts.
          findWebView(findViewById(android.R.id.content))?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('ra-back-request', { cancelable: true }));",
            null,
          )
        }
      },
    )
    installBookPickBridge()
  }

  /**
   * The app window is never zoomable. The stock WebView only pinch-zooms
   * with built-in zoom controls on, yet the whole app zoomed on users'
   * devices, so state the settings rather than inherit the device's defaults.
   * The viewport meta in index.html fixes the scale on the web side as well,
   * and fixed-layout books zoom through their own pinch handling.
   */
  override fun onWebViewCreate(webView: WebView) {
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
    if (OnyxEink.isDevice) {
      // Before the bundle evaluates, so first-run reader defaults can see it.
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        WebViewCompat.addDocumentStartJavaScript(
          webView,
          "document.documentElement.dataset.eink='1';",
          setOf("*"),
        )
      }
      OnyxEink.prepareWebView(webView)
      markEinkDocument()
    }
  }

  /** Called from Rust (the `move_task_to_back` command): background the app
   *  like Home does, keeping the process (and the loaded book) warm. */
  fun sendToBackground() {
    runOnUiThread { moveTaskToBack(true) }
  }

  /**
   * Show/hide the system status bar. Called from Rust (the
   * `set_status_bar_hidden` command) while the reader is open, for an
   * immersive reading surface. A swipe from the top edge reveals the bar
   * transiently while hidden.
   */
  fun setStatusBarHidden(hidden: Boolean) {
    runOnUiThread {
      val controller = WindowCompat.getInsetsController(window, window.decorView)
      if (hidden) {
        controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.statusBars())
        // BOOX draws its own navigation strip. Hiding it with the status bar
        // gives the page the full panel; a swipe still reveals both.
        if (OnyxEink.isDevice) controller.hide(WindowInsetsCompat.Type.navigationBars())
      } else {
        controller.show(WindowInsetsCompat.Type.statusBars())
        if (OnyxEink.isDevice) controller.show(WindowInsetsCompat.Type.navigationBars())
      }
    }
  }

  /**
   * Re-dispatch the current window insets. Called from Rust (the
   * `sync_safe_area` command) once the web app has booted: a freshly loaded
   * document starts back at the CSS defaults (0), and the insets listener
   * above only fires again when the insets themselves change.
   */
  fun syncSafeArea() {
    runOnUiThread { findViewById<View>(android.R.id.content).requestApplyInsets() }
  }

  /** Called from Rust (the `set_volume_key_capture` command). */
  fun setVolumeKeyCapture(captured: Boolean) {
    volumeKeysCaptured = captured
  }

  /** Called from Rust (the `set_reader_page_key_capture` command). */
  fun setReaderPageKeyCapture(captured: Boolean) {
    readerPageKeysCaptured = captured
  }

  /**
   * Called from Rust (the `set_reader_keep_awake` command) for the lifetime
   * of an open book. On Onyx, hold the panel awake — e-ink draws almost
   * nothing once the page is still, and the system timeout would blank it
   * mid-chapter. Released when the reader unmounts, including while a note
   * field has focus (page keys are released separately in that case).
   */
  fun setReaderKeepAwake(awake: Boolean) {
    if (!OnyxEink.isDevice) return
    runOnUiThread {
      if (awake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  /**
   * Publish the open book's cover as the BOOX standby image. Called from Rust
   * (`set_onyx_lock_cover`) when a book opens and again if its cover arrives
   * later. [sourcePath] is an app-private raster (empty when the book has no
   * decodable cover — the shell draws [title] instead). No-op off Onyx.
   * Closing the book does not clear the image: the ROM cannot restore the
   * previous screensaver.
   */
  fun setLockCover(sourcePath: String, title: String) {
    if (!OnyxEink.isDevice) return
    val (width, height) = panelPixels()
    OnyxLockCover.publish(this, sourcePath, title, width, height)
  }

  private fun panelPixels(): Pair<Int, Int> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val mode = display?.mode
      if (mode != null && mode.physicalWidth > 0 && mode.physicalHeight > 0) {
        return mode.physicalWidth to mode.physicalHeight
      }
    }
    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    windowManager.defaultDisplay.getRealMetrics(metrics)
    return metrics.widthPixels to metrics.heightPixels
  }

  /** Current Android build number, used to reject non-upgrade release APKs. */
  fun installedVersionCode(): Long {
    @Suppress("DEPRECATION")
    val packageInfo = packageManager.getPackageInfo(packageName, 0)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode
    } else {
      @Suppress("DEPRECATION")
      packageInfo.versionCode.toLong()
    }
  }

  /** Open Android's system package installer for an update verified by Rust. */
  fun installUpdateApk(apkPath: String): String {
    val apk = File(apkPath)
    if (!apk.isFile) return "error:Downloaded update APK does not exist"

    pendingUpdateApkPath = apkPath
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !packageManager.canRequestPackageInstalls()
    ) {
      return try {
        startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:$packageName"),
          ),
        )
        "permission-required"
      } catch (error: Throwable) {
        pendingUpdateApkPath = null
        "error:${error.message ?: error.javaClass.name}"
      }
    }

    return openPackageInstaller(apk)
  }

  override fun onResume() {
    super.onResume()
    if (OnyxEink.isDevice) {
      findViewById<View>(android.R.id.content)?.let { OnyxEink.onResume(it) }
      markEinkDocument()
    }
    val apkPath = pendingUpdateApkPath ?: return
    if (
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
        packageManager.canRequestPackageInstalls()
    ) {
      openPackageInstaller(File(apkPath))
    }
  }

  private fun openPackageInstaller(apk: File): String {
    pendingUpdateApkPath = null
    return try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
      startActivity(
        Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        },
      )
      findWebView(findViewById(android.R.id.content))?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('ra-android-installer-opened'));",
        null,
      )
      "installer-started"
    } catch (error: Throwable) {
      "error:${error.message ?: error.javaClass.name}"
    }
  }

  /** Called from Rust (`book_pick_start`) or the webview JS bridge: launch the system document picker
   *  for book files. The result is parked in [bookPickResult] rather than
   *  pushed to the webview — see that field's comment. */
  @JavascriptInterface
  fun startBookPick(generation: Int) {
    bookPickGeneration = generation
    bookPickResult = null
    runOnUiThread {
      try {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          putExtra(
            Intent.EXTRA_MIME_TYPES,
            // Must cover every importable format (mirror BOOK_FILE_ACCEPT in
            // pick-book-files.ts): SAF greys out anything not listed here.
            // txt/html/cbz/cbr were missing for months after those formats
            // landed — "Android can't import TXT" was this list, not the app.
            arrayOf(
              "application/epub+zip",
              "application/pdf",
              "application/x-mobipocket-ebook",
              "application/vnd.amazon.ebook",
              "application/x-fictionbook+xml",
              "application/vnd.comicbook+zip",
              "application/vnd.comicbook-rar",
              "text/plain",
              "text/html",
              "application/octet-stream",
            ),
          )
        }
        @Suppress("DEPRECATION")
        startActivityForResult(intent, BOOK_PICK_REQUEST)
      } catch (error: Throwable) {
        bookPickResult = listOf(
          generation.toString(),
          "__ERROR__:${error.message ?: error.javaClass.name}",
        ).joinToString("\n")
        bookPickGeneration = 0
      }
    }
  }

  /** Called from Rust (`book_pick_poll`) or the webview JS bridge: hand over the parked pick result
   *  (and clear it), or null while the picker is still open. */
  @JavascriptInterface
  fun takeBookPickResult(): String? {
    val result = bookPickResult
    if (result != null) bookPickResult = null
    return result
  }

  @Deprecated("classic result API is intentional here")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != BOOK_PICK_REQUEST) return
    val uris = mutableListOf<Uri>()
    if (resultCode == RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
      } else {
        data.data?.let { uris.add(it) }
      }
    }
    val picks = uris.map { uri -> describePick(uri) }
    bookPickResult = (listOf(bookPickGeneration.toString()) + picks).joinToString("\n")
    bookPickGeneration = 0
  }

  /** "<uri>\t<displayName>\t<size>" — name empty / size -1 when the provider
   *  won't say. Tabs cannot survive inside either field: URIs are encoded,
   *  and a display name containing a tab is sanitized rather than parked. */
  private fun describePick(uri: Uri): String {
    var name = ""
    var size = -1L
    try {
      contentResolver.query(
        uri,
        arrayOf(
          android.provider.OpenableColumns.DISPLAY_NAME,
          android.provider.OpenableColumns.SIZE,
        ),
        null,
        null,
        null,
      )?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
            name = cursor.getString(nameIndex).replace('\t', ' ').replace('\n', ' ')
          }
          val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
      }
    } catch (_: Throwable) {
      // A provider that refuses to answer still yields a usable pick.
    }
    return "$uri\t$name\t$size"
  }

  /**
   * While captured, turn volume-key presses into sentence-navigator steps:
   * volume down moves forward, volume up moves back (the e-reader convention).
   * Key auto-repeat comes through as repeated ACTION_DOWNs, so holding a key
   * steps continuously. Both actions are consumed so the volume HUD stays away;
   * everything else falls through to the system.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val keyCode = event.keyCode
    val isVolumeKey =
      keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP
    // Sentence mode wins the volume rocker. Page keys still turn pages.
    if (volumeKeysCaptured && isVolumeKey) {
      if (event.action == KeyEvent.ACTION_DOWN) dispatchReaderEvent("ra-volume-step", volumeDirection(keyCode))
      return true
    }
    if (readerPageKeysCaptured) {
      val direction = ReaderKeys.pageTurn(keyCode, OnyxEink.isDevice)
      if (direction != null) {
        if (event.action == KeyEvent.ACTION_DOWN) {
          // Keep the event name in step with platform/page-keys.ts.
          dispatchReaderEvent("ra-page-turn", direction)
          findViewById<View>(android.R.id.content)?.let { OnyxEink.notePageTurn(it) }
        }
        // Consume up as well so the WebView cannot also scroll, and so the
        // volume HUD stays hidden when the rocker is paging.
        return true
      }
      // Leaf 5's case keys were not captured on hardware here. A single
      // log line per press is enough to map an unexpected code later.
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
        Log.i("ReadAwareKeys", "reader key not mapped keyCode=$keyCode scanCode=${event.scanCode}")
      }
    }
    return super.dispatchKeyEvent(event)
  }

  private fun volumeDirection(keyCode: Int): String =
    if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) ReaderKeys.NEXT else ReaderKeys.PREV

  /** `detail` is one of the fixed direction tokens, never external input. */
  private fun dispatchReaderEvent(name: String, direction: String) {
    findWebView(findViewById(android.R.id.content))?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('$name', { detail: '$direction' }));",
      null,
    )
  }

  /** Stamp the e-ink flag once the document exists, plus the density the shell measured. */
  private fun markEinkDocument() {
    val density = OnyxDisplay.appliedDensityDpi
    val ppi = OnyxDisplay.physicalPpi
    val js = buildString {
      append("document.documentElement&&(document.documentElement.dataset.eink='1'")
      if (density > 0) append(",document.documentElement.dataset.einkDensity='$density'")
      if (ppi > 0) append(",document.documentElement.dataset.einkPpi='$ppi'")
      append(");")
    }
    val root = findViewById<View>(android.R.id.content) ?: return
    fun attempt(left: Int) {
      val webView = findWebView(root)
      if (webView != null) {
        webView.evaluateJavascript(js, null)
        return
      }
      if (left > 0) root.postDelayed({ attempt(left - 1) }, 50)
    }
    attempt(20)
  }

  private fun installBookPickBridge() {
    val root = findViewById<View>(android.R.id.content)
    fun install(attemptsLeft: Int) {
      val webView = findWebView(root)
      if (webView != null) {
        webView.addJavascriptInterface(this, "ReadAwareAndroid")
        return
      }
      if (attemptsLeft > 0) root.postDelayed({ install(attemptsLeft - 1) }, 50)
    }
    install(20)
  }

  /** Push the system-bar + cutout insets into the web layer's CSS variables. */
  private fun applySafeAreaToWebView(insets: WindowInsetsCompat) {
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    // While the IME is up, the content view is already padded past it (see the
    // insets listener), so the webview's bottom edge sits above the keyboard —
    // and above the nav bar the keyboard covers. Keeping the nav-bar value in
    // --ra-safe-bottom would double the clearance under bottom-anchored chrome.
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val safeBottom = maxOf(bars.bottom - ime.bottom, 0)
    // WebView CSS pixels are physical pixels over the display density.
    val density = resources.displayMetrics.density
    val js = """
      (function () {
        var s = document.documentElement.style;
        s.setProperty('--ra-safe-top', '${bars.top / density}px');
        s.setProperty('--ra-safe-right', '${bars.right / density}px');
        s.setProperty('--ra-safe-bottom', '${safeBottom / density}px');
        s.setProperty('--ra-safe-left', '${bars.left / density}px');
      })();
    """.trimIndent()
    findWebView(findViewById(android.R.id.content))?.evaluateJavascript(js, null)
  }

  private fun findWebView(root: View): WebView? {
    if (root is WebView) return root
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        findWebView(root.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
