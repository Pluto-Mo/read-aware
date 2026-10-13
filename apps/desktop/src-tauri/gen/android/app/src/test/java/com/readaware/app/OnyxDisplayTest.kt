package com.readaware.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OnyxDisplayTest {
  @Test
  fun leaf5TargetsElevenPointBody() {
    // 1680×1264 at 300 ppi is a 7" panel. 17 CSS px (reader "medium") ≈ 11 pt.
    assertEquals(431, OnyxDisplay.targetDensityDpi(1680, 1264, 300f, 300f))
    assertEquals(431, OnyxDisplay.targetDensityDpi(1264, 1680, 300f, 300f))
  }

  @Test
  fun rejectsMetricsThatAreNotAReaderPanel() {
    assertNull(OnyxDisplay.targetDensityDpi(1920, 1080, 96f, 96f))
    assertNull(OnyxDisplay.targetDensityDpi(100, 100, 300f, 300f))
    assertNull(OnyxDisplay.targetDensityDpi(1680, 1264, 300f, 480f))
    assertNull(OnyxDisplay.targetDensityDpi(1680, 1264, 0f, 0f))
  }
}
