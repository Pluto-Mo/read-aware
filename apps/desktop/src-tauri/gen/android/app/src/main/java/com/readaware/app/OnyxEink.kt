package com.readaware.app

import android.os.Build
import android.util.Log
import android.view.View
import android.webkit.WebView

/**
 * BOOX e-ink refresh for the WebView reader.
 *
 * The public Onyx SDK (`onyxsdk-device` 1.3.6 / `onyxsdk-base` 1.8.9 on
 * repo.boox.com) does not talk to the panel itself. `EpdController` delegates
 * to `SDMDevice` (Qualcomm — Leaf 5), which reflects into ROM classes. Those
 * AAR graphs also pull databinding, RxJava and MMKV, so this calls the same
 * ROM entry points directly and no-ops when they are absent.
 *
 * Applied when the device looks like Onyx:
 * - `WebView.setCssInjectEnabled(true)` — `EpdController.setWebViewContrastOptimize`,
 *   which keeps the WebView out of A2 (binary) refresh.
 * - `View.setDefaultUpdateMode(UI_REGAL_MODE)` — REGAL partial updates, the
 *   text-page waveform (`UpdateMode.REGAL`).
 * - `EInkHelper.setAppScopeRefreshMode(UPDATE_MODE_REGAL)` —
 *   `UpdateOption.REGAL` (minimal ghosting on a light page). App-scoped, not
 *   the system-wide scheme.
 * - `ViewUpdateHelper.applyGCOnce()` every few page turns and when the
 *   activity resumes, matching `EpdDeviceManager`'s GC interval.
 *
 * Not applied (see the PR audit): fast/A2 animation mode, system-wide update
 * lock, front light, pen/scribble, dictionary, touch-region disable, EAC
 * toggle, legacy `hide_status_bar` broadcast, changing the device sleep timeout.
 * Panel density is [OnyxDisplay]; the standby cover is [OnyxLockCover].
 */
object OnyxEink {
  private const val TAG = "ReadAwareEink"
  private const val VIEW_UPDATE = "android.onyx.ViewUpdateHelper"
  private const val EINK_HELPER = "android.onyx.optimization.EInkHelper"
  private const val EINK_CONSTANT = "android.onyx.optimization.Constant"

  /** Partials between full flashes. The Onyx demo uses 5; 8 stays readable without a flash on every turn. */
  private const val GC_INTERVAL = 8
  private const val GC_DELAY_MS = 450L

  val isDevice: Boolean by lazy { detect() }

  private var partialTurns = 0
  private val fullRefresh = Runnable { applyGcOnce() }

  fun prepareWebView(webView: WebView) {
    if (!isDevice) return
    // Glow and scrollbars are extra partials that ghost on EPD.
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    val contrast = invoke(webView, "setCssInjectEnabled", true)
    val regal = staticInt(VIEW_UPDATE, "UI_REGAL_MODE")
    val viewMode = if (regal != null) invoke(webView, "setDefaultUpdateMode", regal) else false
    val appRegal = staticInt(EINK_CONSTANT, "UPDATE_MODE_REGAL")
    val appMode =
      if (appRegal != null) invokeStatic(EINK_HELPER, "setAppScopeRefreshMode", appRegal) else false
    Log.i(TAG, "prepare contrast=$contrast viewRegal=$viewMode appRegal=$appMode")
  }

  /** Count a reader page turn and schedule a full GC once the panel has settled. */
  fun notePageTurn(anchor: View) {
    if (!isDevice) return
    partialTurns += 1
    anchor.removeCallbacks(fullRefresh)
    if (partialTurns >= GC_INTERVAL) {
      partialTurns = 0
      anchor.postDelayed(fullRefresh, GC_DELAY_MS)
    }
  }

  /** Clear ghosting left by the previous activity once this window is showing again. */
  fun onResume(anchor: View) {
    if (!isDevice) return
    anchor.removeCallbacks(fullRefresh)
    anchor.postDelayed(fullRefresh, GC_DELAY_MS)
  }

  private fun applyGcOnce() {
    if (invokeStatic(VIEW_UPDATE, "applyGCOnce")) return
    invokeStatic(VIEW_UPDATE, "repaintEverything")
  }

  private fun detect(): Boolean {
    val blob =
      listOf(Build.BRAND, Build.MANUFACTURER, Build.MODEL, Build.DEVICE, Build.PRODUCT, Build.HARDWARE)
        .joinToString(" ") { it.lowercase() }
    if ("onyx" in blob || "boox" in blob) return true
    return try {
      Class.forName(VIEW_UPDATE)
      true
    } catch (_: Throwable) {
      false
    }
  }

  private fun staticInt(className: String, field: String): Int? {
    return try {
      val type = Class.forName(className)
      type.getField(field).getInt(null)
    } catch (error: Throwable) {
      Log.d(TAG, "$className.$field unavailable: ${error.javaClass.simpleName}")
      null
    }
  }

  private fun invoke(target: Any, name: String, vararg args: Any): Boolean {
    return try {
      val method = findMethod(target.javaClass, name, args)
      method.isAccessible = true
      method.invoke(target, *args)
      true
    } catch (error: Throwable) {
      Log.d(TAG, "${target.javaClass.simpleName}.$name unavailable: ${error.javaClass.simpleName}")
      false
    }
  }

  private fun invokeStatic(className: String, name: String, vararg args: Any): Boolean {
    return try {
      val type = Class.forName(className)
      val method = findMethod(type, name, args)
      method.isAccessible = true
      method.invoke(null, *args)
      true
    } catch (error: Throwable) {
      Log.d(TAG, "$className.$name unavailable: ${error.javaClass.simpleName}")
      false
    }
  }

  private fun findMethod(type: Class<*>, name: String, args: Array<out Any>): java.lang.reflect.Method {
    val signature = args.map { paramType(it) }.toTypedArray()
    var current: Class<*>? = type
    while (current != null) {
      try {
        return current.getMethod(name, *signature)
      } catch (_: NoSuchMethodException) {
      }
      try {
        return current.getDeclaredMethod(name, *signature)
      } catch (_: NoSuchMethodException) {
      }
      current = current.superclass
    }
    throw NoSuchMethodException(name)
  }

  private fun paramType(value: Any): Class<*> =
    when (value) {
      is Boolean -> Boolean::class.javaPrimitiveType!!
      is Int -> Int::class.javaPrimitiveType!!
      else -> value.javaClass
    }
}
