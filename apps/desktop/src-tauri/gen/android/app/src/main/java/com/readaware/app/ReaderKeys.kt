package com.readaware.app

import android.view.KeyEvent

/**
 * Hardware page-turn mapping for the reader.
 *
 * Android's WebView consumes [KeyEvent.KEYCODE_PAGE_UP] and
 * [KeyEvent.KEYCODE_PAGE_DOWN] as a native scroll (`pageUp` / `pageDown`)
 * before JavaScript ever sees `PageUp` / `PageDown`. Foliate paginates with
 * CSS columns, so that scroll does not turn a page. BOOX documents the same
 * gesture on several codes (Mobileread / Onyx key lists): 92/93 page,
 * 24/25 volume (Leaf magnetic case and some side keys), 21/22 and sometimes
 * 19/20 d-pad. Volume and d-pad are only stolen on Onyx, and only while the
 * reader asked for capture, so a phone's volume rocker and keyboard focus
 * navigation stay intact.
 *
 * Volume-down / page-down / d-pad-right move forward — the same direction
 * the sentence navigator already uses for volume keys.
 */
object ReaderKeys {
  const val NEXT = "next"
  const val PREV = "prev"

  fun pageTurn(keyCode: Int, onyx: Boolean): String? {
    when (keyCode) {
      KeyEvent.KEYCODE_PAGE_DOWN -> return NEXT
      KeyEvent.KEYCODE_PAGE_UP -> return PREV
    }
    if (!onyx) return null
    return when (keyCode) {
      KeyEvent.KEYCODE_VOLUME_DOWN,
      KeyEvent.KEYCODE_DPAD_RIGHT,
      KeyEvent.KEYCODE_DPAD_DOWN,
      -> NEXT
      KeyEvent.KEYCODE_VOLUME_UP,
      KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_UP,
      -> PREV
      else -> null
    }
  }
}
