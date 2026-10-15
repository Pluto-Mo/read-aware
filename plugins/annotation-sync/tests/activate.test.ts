import { describe, expect, test } from "bun:test";
import plugin from "../src/index";

describe("plugin activation", () => {
  test("registers the shelf page and agent contributions", async () => {
    const registered: string[] = [];
    await plugin.activate({
      locale: "en",
      domains: { library: { queries: { books: {} } } },
      services: { network: { fetch: async () => new Response() } },
      contributions: {
        headerActions: { register: (action: { id: string }) => registered.push(action.id) },
        commands: { register: (command: { id: string }) => registered.push(command.id) },
        agentTools: { register: (tool: { name: string }) => registered.push(tool.name) },
        agentContextProviders: { register: (provider: { id: string }) => registered.push(`context:${provider.id}`) },
        agentRetrievalProviders: {
          register: (provider: { id: string }) => registered.push(`retrieve:${provider.id}`),
        },
      },
    } as never);
    expect(registered).toEqual([
      "annotation-sync",
      "open",
      "list_imported_annotations",
      "retrieve:imported-annotations",
      "context:imported-annotations",
    ]);
  });
});
