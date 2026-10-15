package com.readaware.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OnyxDisplayTest {
  @Test
  fun leavesEinkCenterBandAlone() {
    // Leaf 5 pixels at 300 ppi. A density E-Ink Center already set is kept,
    // including values that are not the panel ppi.
    assertEquals(300, OnyxDisplay.targetDensityDpi(300, 1680, 1264, 300f, 300f))
    assertEquals(320, OnyxDisplay.targetDensityDpi(320, 1680, 1264, 300f, 300f))
    assertEquals(350, OnyxDisplay.targetDensityDpi(350, 1680, 1264, 300f, 300f))
    assertEquals(280, OnyxDisplay.targetDensityDpi(280, 1264, 1680, 300f, 300f))
  }

  @Test
  fun nudgesOutsideBandIntoPanelOrEdge() {
    // 431 was the old invented target. It is outside 280–350, so it moves to
    // the measured 300 ppi, which is inside the band.
    assertEquals(300, OnyxDisplay.targetDensityDpi(431, 1680, 1264, 300f, 300f))
    assertEquals(300, OnyxDisplay.targetDensityDpi(160, 1680, 1264, 300f, 300f))
    // No trustworthy ppi: clamp to the nearest edge of the band.
    assertEquals(350, OnyxDisplay.targetDensityDpi(431, 1680, 1264, 0f, 0f))
    assertEquals(280, OnyxDisplay.targetDensityDpi(200, 100, 100, 300f, 300f))
  }

  @Test
  fun rejectsMetricsThatAreNotAReaderPanel() {
    assertNull(OnyxDisplay.trustedPpi(1920, 1080, 96f, 96f))
    assertNull(OnyxDisplay.trustedPpi(100, 100, 300f, 300f))
    assertNull(OnyxDisplay.trustedPpi(1680, 1264, 300f, 480f))
    assertEquals(300, OnyxDisplay.trustedPpi(1680, 1264, 300f, 300f))
  }
}
