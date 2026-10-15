package com.readaware.app

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReaderKeysTest {
  @Test
  fun pageKeysAlwaysTurn() {
    assertEquals(ReaderKeys.NEXT, ReaderKeys.pageTurn(KeyEvent.KEYCODE_PAGE_DOWN, false))
    assertEquals(ReaderKeys.PREV, ReaderKeys.pageTurn(KeyEvent.KEYCODE_PAGE_UP, false))
    assertEquals(ReaderKeys.NEXT, ReaderKeys.pageTurn(KeyEvent.KEYCODE_PAGE_DOWN, true))
    assertEquals(ReaderKeys.PREV, ReaderKeys.pageTurn(KeyEvent.KEYCODE_PAGE_UP, true))
  }

  @Test
  fun volumeAndDpadOnlyOnOnyx() {
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_VOLUME_DOWN, false))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_VOLUME_UP, false))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_RIGHT, false))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_LEFT, false))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_DOWN, false))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_UP, false))
    assertEquals(ReaderKeys.NEXT, ReaderKeys.pageTurn(KeyEvent.KEYCODE_VOLUME_DOWN, true))
    assertEquals(ReaderKeys.PREV, ReaderKeys.pageTurn(KeyEvent.KEYCODE_VOLUME_UP, true))
    assertEquals(ReaderKeys.NEXT, ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_RIGHT, true))
    assertEquals(ReaderKeys.NEXT, ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_DOWN, true))
    assertEquals(ReaderKeys.PREV, ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_LEFT, true))
    assertEquals(ReaderKeys.PREV, ReaderKeys.pageTurn(KeyEvent.KEYCODE_DPAD_UP, true))
  }

  @Test
  fun systemKeysAreNotStolen() {
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_BACK, true))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_MENU, true))
    assertNull(ReaderKeys.pageTurn(KeyEvent.KEYCODE_HOME, true))
    // F4 is the system full-refresh key on several BOOX builds.
    assertNull(ReaderKeys.pageTurn(134, true))
  }
}
