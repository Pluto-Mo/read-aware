import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "../../../i18n";
import { ResourceOwner } from "../../../services/resource-owner";
import { resourceAdapter } from "../../../services/resources";
import { useDropBookImport } from "../../library/hooks/useDropBookImport";
import { registerPluginFileDropOwner } from "../lib/plugin-file-drop";
import { decodePluginCallbacks, PluginCallbackRegistry } from "../runtime/plugin-callback-wire";
import { normalizePluginView } from "../lib/plugin-view";
import { PluginFileDrop } from "./PluginFileDrop";

test("mounted drop target names its owner, blocks synthetic grants and double import, cancels hidden picker", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!),
    lifetime = new AbortController(),
    registry = new PluginCallbackRegistry();
  let imports = 0,
    grants = 0,
    delivered = 0;
  const released: string[] = [],
    errors: unknown[] = [];
  const delayed = Promise.withResolvers<void>();
  let wait = false;
  const owner = new ResourceOwner(
    {
      ...resourceAdapter,
      pick: async () => {
        grants++;
        if (wait) await delayed.promise;
        return [{ id: `native-${grants}`, name: "book.epub", size: 3, mimeType: "application/epub+zip" }];
      },
      release: async (id) => {
        released.push(id);
      },
    },
    (error) => errors.push(error),
  );
  registerPluginFileDropOwner(lifetime.signal, "Annotations", owner);
  const view = normalizePluginView(
    decodePluginCallbacks(
      registry.encode({
        kind: "markdown",
        markdown: "x",
        fileDrop: {
          onDrop: () => {
            delivered++;
            return null;
          },
        },
      }),
      (handle, args) => registry.invoke(handle, args),
      undefined,
      lifetime.signal,
    ),
  );
  function Probe({ visible = true }: { visible?: boolean }) {
    const active = useDropBookImport(
      async () => {
        imports++;
      },
      (error) => errors.push(error),
    );
    return (
      <>
        <output>{String(active)}</output>
        <PluginFileDrop
          drop={view.fileDrop!}
          busy={false}
          visible={visible}
          onResult={async (run) => {
            try {
              return await run();
            } catch (error) {
              errors.push(error);
              return null;
            }
          }}
        />
      </>
    );
  }
  const event = (name: string) => {
    const value = new dom.window.Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(value, "dataTransfer", {
      value: { types: ["Files"], files: [new File(["a"], "a.epub")], items: [], dropEffect: "none", getData: () => "" },
    });
    return value;
  };
  try {
    await initI18n("en");
    await act(async () => {
      root.render(<Probe />);
    });
    const zone = dom.window.document.querySelector("[data-plugin-file-drop]")!;
    expect(zone.getAttribute("aria-label")).toContain("Annotations");
    await act(async () => {
      dom.window.dispatchEvent(event("dragenter"));
    });
    expect(dom.window.document.querySelector("output")!.textContent).toBe("true");
    await act(async () => {
      zone.dispatchEvent(event("dragenter"));
    });
    expect(dom.window.document.querySelector("output")!.textContent).toBe("false");
    const drop = event("drop");
    await act(async () => {
      zone.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(imports).toBe(0);
    expect(grants).toBe(0);
    expect(delivered).toBe(0);
    await act(async () => {
      dom.window.document.querySelector("button")!.click();
    });
    expect(grants).toBe(1);
    expect(delivered).toBe(1);
    wait = true;
    await act(async () => {
      dom.window.document.querySelector("button")!.click();
    });
    await act(async () => {
      root.render(<Probe visible={false} />);
    });
    await act(async () => {
      delayed.resolve();
    });
    expect(delivered).toBe(1);
    expect(released).toContain("native-2");
    await act(async () => {
      dom.window.dispatchEvent(event("drop"));
    });
    expect(imports).toBe(1);
  } finally {
    delayed.resolve();
    await act(async () => {
      root.unmount();
    });
    lifetime.abort();
    await owner.dispose();
    registry.clear();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
