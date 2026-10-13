package com.readaware.app

import android.content.Context
import android.content.res.Configuration
import android.util.Log
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Logical density for an Onyx panel, measured from the live display.
 *
 * BOOX does not promise that `densityDpi` matches the panel. A phone-sized
 * density on a 7" 300 ppi screen makes the reader's "medium" tier (17 CSS px)
 * about 7.6 pt — small at arm's length — while the phone bottom bar stays a
 * large share of a short landscape page. This retargets density so those
 * 17 CSS px land near 11 pt on the measured panel. Reader chrome is slimmed
 * separately in CSS; this does not hardcode 1.875 or Leaf 5's pixel size.
 *
 * Skipped when xdpi/ydpi do not describe a 5.5–14" panel. Non-Onyx devices
 * never call [wrap].
 */
object OnyxDisplay {
  private const val TAG = "ReadAwareDisplay"

  /** Last values applied, so the document can record what the shell measured. */
  @Volatile var appliedDensityDpi: Int = 0
    private set

  @Volatile var physicalPpi: Int = 0
    private set

  /**
   * Density that makes 17 CSS px ≈ 11 pt.
   *
   * `1 CSS px = (densityDpi / 160) / ppi` inches, and 11 pt = 11/72 inch,
   * so `densityDpi = ppi * 160 * (11/72) / 17`.
   */
  fun targetDensityDpi(widthPx: Int, heightPx: Int, xdpi: Float, ydpi: Float): Int? {
    if (widthPx < 400 || heightPx < 400) return null
    if (xdpi !in 180f..600f || ydpi !in 180f..600f) return null
    val ppi = (xdpi + ydpi) / 2f
    if (abs(xdpi - ydpi) / ppi > 0.15f) return null
    val diagonal = hypot(widthPx.toFloat(), heightPx.toFloat()) / ppi
    if (diagonal !in 5.5f..14f) return null
    return (ppi * 160f * (11f / 72f) / 17f).roundToInt().coerceIn(220, 520)
  }

  /** Activity base context. No-op when the measured panel cannot be trusted. */
  fun wrap(base: Context): Context {
    val metrics = base.resources.displayMetrics
    val target = targetDensityDpi(metrics.widthPixels, metrics.heightPixels, metrics.xdpi, metrics.ydpi)
    val ppi = if (metrics.xdpi > 0f && metrics.ydpi > 0f) ((metrics.xdpi + metrics.ydpi) / 2f).roundToInt() else 0
    physicalPpi = ppi
    Log.i(
      TAG,
      "w=${metrics.widthPixels} h=${metrics.heightPixels} densityDpi=${metrics.densityDpi} " +
        "xdpi=${metrics.xdpi} ydpi=${metrics.ydpi} density=${metrics.density} " +
        "ppi=$ppi target=$target",
    )
    if (target == null) return base
    appliedDensityDpi = target
    if (abs(target - metrics.densityDpi) < 16) return base
    val config = Configuration(base.resources.configuration)
    config.densityDpi = target
    Log.i(TAG, "densityDpi ${metrics.densityDpi} -> $target")
    return base.createConfigurationContext(config)
  }
}
