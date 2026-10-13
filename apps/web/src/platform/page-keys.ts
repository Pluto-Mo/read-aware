import { invoke } from "./ipc";
import { isAndroid, isTauri } from "./environment";

/**
 * Custom DOM event dispatched by the Android shell when a captured page-turn
 * key is pressed. `detail` is the turn direction. Keep the name in step with
 * MainActivity.dispatchKeyEvent.
 */
export const PAGE_TURN_EVENT = "ra-page-turn";

export type PageTurnDirection = "next" | "prev";

/**
 * Route Android page-turn keys to the reader (dispatched as PAGE_TURN_EVENT)
 * instead of letting the WebView scroll. Enabled for the lifetime of the
 * reader and released while a text field is focused. No-op off Android.
 */
export function setReaderPageKeyCapture(captured: boolean): void {
  if (!isTauri() || !isAndroid()) return;
  void invoke("set_reader_page_key_capture", { captured }).catch(() => {
    // Older shell builds without the command — paging stays touch-only.
  });
}

/**
 * Hold the Onyx panel awake while a book is open. Independent of page-key
 * capture, which drops while a text field is focused. No-op off Android,
 * and a no-op on Android devices that are not Onyx.
 */
export function setReaderKeepAwake(awake: boolean): void {
  if (!isTauri() || !isAndroid()) return;
  void invoke("set_reader_keep_awake", { awake }).catch(() => {
    // Older shell builds without the command.
  });
}

/**
 * Ask an Onyx device to use this book's cover as the standby / lock image.
 * No-op off Android. The shell no-ops on devices that are not Onyx, and
 * leaves the last image in place when the reader closes.
 */
export function setOnyxLockCover(bookId: string): void {
  if (!isTauri() || !isAndroid()) return;
  void invoke("set_onyx_lock_cover", { bookId }).catch(() => {
    // Older shell builds without the command.
  });
}
