package com.readaware.app

import android.content.Context
import android.content.res.Configuration
import android.util.Log
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Display density for a third-party app on BOOX.
 *
 * E-Ink Center → App Optimization asks for a display DPI of 280–350 (the
 * control often starts at 350). That setting is the device density this
 * activity sees. Replacing it with a computed value (the previous 431 dpi
 * target) fights the optimizer. A density already inside the band is left
 * alone. A density outside it is nudged to the measured panel ppi when that
 * ppi sits in the band, otherwise to the nearest edge. The target is never
 * outside 280–350.
 *
 * Reading size is not solved here. Body text lives in the Foliate stylesheet
 * so it can meet the Eink guide's 14sp floor without scaling the whole UI.
 * Non-Onyx devices never call [wrap].
 */
object OnyxDisplay {
  private const val TAG = "ReadAwareDisplay"
  const val DPI_MIN = 280
  const val DPI_MAX = 350

  /** Density the WebView will use, for the document stamp. */
  @Volatile var appliedDensityDpi: Int = 0
    private set

  @Volatile var physicalPpi: Int = 0
    private set

  /**
   * Density to run at. [currentDpi] in 280–350 is returned unchanged.
   * Otherwise the trusted panel ppi, clamped into that band.
   */
  fun targetDensityDpi(currentDpi: Int, widthPx: Int, heightPx: Int, xdpi: Float, ydpi: Float): Int {
    if (currentDpi in DPI_MIN..DPI_MAX) return currentDpi
    val ppi = trustedPpi(widthPx, heightPx, xdpi, ydpi)
    if (ppi != null && ppi in DPI_MIN..DPI_MAX) return ppi
    return currentDpi.coerceIn(DPI_MIN, DPI_MAX)
  }

  /** Activity base context. Logs the live metrics either way. */
  fun wrap(base: Context): Context {
    val metrics = base.resources.displayMetrics
    val ppi = trustedPpi(metrics.widthPixels, metrics.heightPixels, metrics.xdpi, metrics.ydpi) ?: 0
    physicalPpi = ppi
    val target = targetDensityDpi(
      metrics.densityDpi,
      metrics.widthPixels,
      metrics.heightPixels,
      metrics.xdpi,
      metrics.ydpi,
    )
    appliedDensityDpi = target
    Log.i(
      TAG,
      "w=${metrics.widthPixels} h=${metrics.heightPixels} densityDpi=${metrics.densityDpi} " +
        "xdpi=${metrics.xdpi} ydpi=${metrics.ydpi} density=${metrics.density} " +
        "ppi=$ppi band=$DPI_MIN-$DPI_MAX target=$target",
    )
    if (target == metrics.densityDpi) return base
    val config = Configuration(base.resources.configuration)
    config.densityDpi = target
    Log.i(TAG, "densityDpi ${metrics.densityDpi} -> $target")
    return base.createConfigurationContext(config)
  }

  /** Panel ppi when xdpi/ydpi describe a 5.5–14" reader. Null when they do not. */
  fun trustedPpi(widthPx: Int, heightPx: Int, xdpi: Float, ydpi: Float): Int? {
    if (widthPx < 400 || heightPx < 400) return null
    if (xdpi !in 180f..600f || ydpi !in 180f..600f) return null
    val ppi = (xdpi + ydpi) / 2f
    if (abs(xdpi - ydpi) / ppi > 0.15f) return null
    val diagonal = hypot(widthPx.toFloat(), heightPx.toFloat()) / ppi
    if (diagonal !in 5.5f..14f) return null
    return ppi.roundToInt()
  }
}
