import { invoke } from "./ipc";

const RESULT_EVENT = "ra-system-reader";

/**
 * Hand the open book's file to NeoReader (com.onyx.kreader). The native side
 * returns "started" and finishes on `ra-system-reader` after the public copy.
 * Other statuses ("skipped", "missing") settle immediately.
 */
export function openInSystemReader(input: { bookId: string; fileName: string; mimeType: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish("error:timeout"), 5 * 60 * 1000);
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      finish(typeof detail === "string" && detail.length > 0 ? detail : "error");
    };
    function finish(status: string) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(RESULT_EVENT, onEvent);
      resolve(status);
    }
    window.addEventListener(RESULT_EVENT, onEvent);
    invoke<string>("open_in_system_reader", {
      bookId: input.bookId,
      fileName: input.fileName,
      mimeType: input.mimeType,
    })
      .then((status) => {
        if (status !== "started") finish(status);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener(RESULT_EVENT, onEvent);
        reject(error);
      });
  });
}
