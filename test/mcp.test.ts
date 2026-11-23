import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";
import { IndexController } from "../src/index/watch.js";
import { registerMcpTools } from "../src/tools/tools.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));

async function connect(): Promise<{
  client: Client;
  server: McpServer;
  controller: IndexController;
  store: DualCacheStore;
  tools: string[];
}> {
  const indexer = new TsReactIndexer(fixture);
  const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: ":memory:" });
  const controller = new IndexController(indexer, store);
  const server = new McpServer({ name: "tsray-test", version: "0.0.0" });
  const tools = registerMcpTools(server, controller, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server, controller, store, tools };
}

afterAll(() => {
  // Each test closes its own transport and store.
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("MCP tool surface", () => {
  it("registers tools and serves the React graph", async () => {
    const { client, server, controller, store, tools } = await connect();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("project_info");
      expect(names).toContain("get_component_tree");
      expect(names).toContain("get_impact_analysis");
      expect(names).toContain("get_summary_coverage");
      expect(names).toContain("run_tests");
      expect(tools.length).toBeGreaterThanOrEqual(20);

      const info = await client.callTool({ name: "project_info", arguments: {} });
      expect(info.isError).toBeFalsy();
      const infoJson = JSON.parse(textOf(info)) as { project_id: string; symbols: number };
      expect(infoJson.project_id).toBe("fixture-react-app");
      expect(infoJson.symbols).toBeGreaterThan(0);

      const tree = await client.callTool({
        name: "get_component_tree",
        arguments: { symbol_id: "App", depth: 2 },
      });
      expect(tree.isError).toBeFalsy();
      const treeJson = JSON.parse(textOf(tree)) as { nodes: Array<{ name: string }> };
      expect(treeJson.nodes.some((node) => node.name === "App")).toBe(true);
      expect(treeJson.nodes.some((node) => node.name === "Button")).toBe(true);

      const lookup = await client.callTool({
        name: "lookup_symbol",
        arguments: { query: "Button" },
      });
      const lookupJson = JSON.parse(textOf(lookup)) as Array<{ name: string; sync_state: string }>;
      expect(lookupJson.some((symbol) => symbol.name === "Button")).toBe(true);
      expect(lookupJson.every((symbol) => typeof symbol.sync_state === "string")).toBe(true);
    } finally {
      await server.close();
      await client.close();
      await controller.stop();
      store.close();
    }
  }, 60_000);

  it("returns actionable errors for unknown symbols", async () => {
    const { client, server, controller, store } = await connect();
    try {
      const result = await client.callTool({
        name: "get_impact_analysis",
        arguments: { symbol_id: "does-not-exist" },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result)) as { error: string };
      expect(payload.error).toBe("symbol_not_found");
    } finally {
      await server.close();
      await client.close();
      await controller.stop();
      store.close();
    }
  }, 60_000);

  it("stores summaries through the MCP upsert tool", async () => {
    const { client, server, controller, store } = await connect();
    try {
      const lookup = await client.callTool({
        name: "lookup_symbol",
        arguments: { query: "sym:src/components/Button.tsx#Button" },
      });
      const symbols = JSON.parse(textOf(lookup)) as Array<{ content_hash: string; id: string }>;
      const target = symbols[0]!;
      const upsert = await client.callTool({
        name: "upsert_summaries",
        arguments: {
          entries: [
            {
              symbol_id: target.id,
              expected_content_hash: target.content_hash,
              summary: { intent: "Button", side_effects: ["none"], invariants: [] },
            },
          ],
        },
      });
      expect(upsert.isError).toBeFalsy();
      const saved = JSON.parse(textOf(upsert)) as { saved: number };
      expect(saved.saved).toBe(1);

      const coverage = await client.callTool({ name: "get_summary_coverage", arguments: {} });
      const coverageJson = JSON.parse(textOf(coverage)) as { synced: number };
      expect(coverageJson.synced).toBe(1);

      const moduleCoverage = await client.callTool({
        name: "get_summary_coverage",
        arguments: { module: "components" },
      });
      const moduleJson = JSON.parse(textOf(moduleCoverage)) as {
        synced: number;
        by_module: Record<string, unknown>;
      };
      expect(moduleJson.synced).toBe(1);
      expect(moduleJson.by_module.components).toBeDefined();
      expect(moduleJson.by_module.root).toBeUndefined();
    } finally {
      await server.close();
      await client.close();
      await controller.stop();
      store.close();
    }
  }, 60_000);
});
