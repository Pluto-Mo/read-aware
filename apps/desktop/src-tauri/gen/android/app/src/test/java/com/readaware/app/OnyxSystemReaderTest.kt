package com.readaware.app

import org.junit.Assert.assertEquals
import org.junit.Test

class OnyxSystemReaderTest {
  @Test
  fun keepsASafeFileNameAndItsExtension() {
    assertEquals("Notes.epub", OnyxSystemReader.shareFileName("Notes.epub", "application/epub+zip"))
    assertEquals("a_b_c.epub", OnyxSystemReader.shareFileName("a/b:c.epub", ""))
  }

  @Test
  fun addsAnExtensionWhenTheTitleHasNone() {
    assertEquals("book.epub", OnyxSystemReader.shareFileName("", "application/epub+zip"))
    assertEquals("Chapter.pdf", OnyxSystemReader.shareFileName("Chapter", "application/pdf"))
    assertEquals("plain", OnyxSystemReader.shareFileName("plain", ""))
  }
}
