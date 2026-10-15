import type { PluginModule } from "@read-aware/plugin-types";
import { assertPluginCapabilities } from "./types";
import { activateAnnotationSync } from "./views";

const plugin: PluginModule = {
  activate(ctx) {
    assertPluginCapabilities(ctx);
    activateAnnotationSync(ctx);
  },
};

export default plugin;
