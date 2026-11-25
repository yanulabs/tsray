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
      for (const tool of listed.tools) {
        expect(tool.inputSchema.properties).toHaveProperty("max_chars");
      }
      for (const name of ["run_tests", "run_typecheck", "run_lint"]) {
        const tool = listed.tools.find((entry) => entry.name === name);
        expect(tool?.inputSchema.properties).toHaveProperty("output_chars");
      }
      expect(listed.tools.find((entry) => entry.name === "project_info")?.inputSchema.properties).toHaveProperty("verbose");

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
      const lookupJson = JSON.parse(textOf(lookup)) as {
        symbols: Array<{ name: string; sync_state: string }>;
      };
      expect(lookupJson.symbols.some((symbol) => symbol.name === "Button")).toBe(true);
      expect(lookupJson.symbols.every((symbol) => typeof symbol.sync_state === "string")).toBe(true);
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

  it("uses compact defaults, pagination, source opt-in, and hard response budgets", async () => {
    const { client, server, controller, store } = await connect();
    try {
      const info = await client.callTool({ name: "project_info", arguments: {} });
      const infoText = textOf(info);
      const infoJson = JSON.parse(infoText) as {
        graph_digest: string;
        projects_total: number;
        tools?: string[];
        project_configs?: unknown[];
        projects?: unknown[];
      };
      expect(infoText.length).toBeLessThan(1800);
      expect(infoJson.graph_digest).toEqual(expect.any(String));
      expect(infoJson.projects_total).toBe(1);
      expect(infoJson.tools).toBeUndefined();
      expect(infoJson.project_configs).toBeUndefined();
      expect(infoJson.projects).toBeUndefined();

      const verbose = await client.callTool({ name: "project_info", arguments: { verbose: true } });
      const verboseText = textOf(verbose);
      const verboseJson = JSON.parse(verboseText) as {
        tool_count: number;
        project_configs: unknown[];
        projects: unknown[];
        total_projects: number;
        returned: number;
        has_more: boolean;
      };
      expect(verboseText.length).toBeLessThan(12_000);
      expect(verboseJson.tool_count).toBeGreaterThanOrEqual(20);
      expect(verboseJson.project_configs.length).toBeGreaterThan(0);
      expect(verboseJson.projects.length).toBeGreaterThan(0);
      expect(verboseJson.total_projects).toBe(1);
      expect(verboseJson.returned).toBe(1);
      expect(verboseJson.has_more).toBe(false);

      const filtered = await client.callTool({
        name: "project_info",
        arguments: { verbose: true, project_filter: "does-not-match", limit: 5, offset: 0 },
      });
      expect(JSON.parse(textOf(filtered)).total_projects).toBe(0);

      const first = await client.callTool({
        name: "lookup_symbol",
        arguments: { query: "Button", limit: 1 },
      });
      const firstJson = JSON.parse(textOf(first)) as {
        total: number;
        next_offset: number | null;
        symbols: Array<Record<string, unknown>>;
      };
      expect(firstJson.total).toBeGreaterThan(1);
      expect(firstJson.next_offset).toBe(1);
      expect(firstJson.symbols[0]).not.toHaveProperty("source_preview");
      expect(firstJson.symbols[0]).not.toHaveProperty("doc");
      expect(firstJson.symbols[0]).toHaveProperty("content_hash");

      const second = await client.callTool({
        name: "lookup_symbol",
        arguments: { query: "Button", limit: 1, offset: 1 },
      });
      const secondJson = JSON.parse(textOf(second)) as { symbols: Array<{ id: string }> };
      expect(secondJson.symbols[0]!.id).not.toBe(firstJson.symbols[0]!.id);

      const withSource = await client.callTool({
        name: "lookup_symbol",
        arguments: { query: "Button", limit: 1, include_source: true, source_chars: 20 },
      });
      const sourceJson = JSON.parse(textOf(withSource)) as {
        symbols: Array<{ source_preview: string }>;
      };
      expect(sourceJson.symbols[0]!.source_preview.length).toBeLessThanOrEqual(20);

      const graph = await client.callTool({
        name: "get_dependency_graph",
        arguments: { scope: "module", max_nodes: 1 },
      });
      const graphJson = JSON.parse(textOf(graph)) as {
        nodes: unknown[];
        total_nodes: number;
        next_node_offset: number | null;
      };
      expect(graphJson.nodes).toHaveLength(1);
      expect(graphJson.total_nodes).toBeGreaterThan(1);
      expect(graphJson.next_node_offset).toBe(1);

      const budgeted = await client.callTool({
        name: "get_codebase_map",
        arguments: { format: "json", max_chars: 1000 },
      });
      expect(textOf(budgeted).length).toBeLessThanOrEqual(1000);
      const budgetJson = JSON.parse(textOf(budgeted)) as {
        _response: { truncated: boolean; max_chars: number };
      };
      expect(budgetJson._response).toMatchObject({ truncated: true, max_chars: 1000 });

      const body = await client.callTool({
        name: "get_function_body",
        arguments: { symbol_id: "App", source_chars: 20, max_chars: 1000 },
      });
      const bodyJson = JSON.parse(textOf(body)) as {
        source: string;
        source_truncated: boolean;
        source_original_chars: number;
      };
      expect(bodyJson.source.length).toBeLessThanOrEqual(20);
      expect(bodyJson.source_truncated).toBe(true);
      expect(bodyJson.source_original_chars).toBeGreaterThan(20);

      const impact = await client.callTool({
        name: "get_impact_analysis",
        arguments: { symbol_id: "App" },
      });
      const impactJson = JSON.parse(textOf(impact)) as {
        target: Record<string, unknown>;
        direct_references: Array<Record<string, unknown>>;
      };
      expect(impactJson.target).not.toHaveProperty("source_preview");
      expect(impactJson.target).not.toHaveProperty("source");
      expect(impactJson.direct_references.every((edge) => "from" in edge && "to" in edge)).toBe(true);

      const stale = await client.callTool({
        name: "list_stale_summaries",
        arguments: { limit: 1 },
      });
      const staleJson = JSON.parse(textOf(stale)) as {
        total: number;
        next_offset: number | null;
        symbols: unknown[];
      };
      expect(staleJson.total).toBeGreaterThan(1);
      expect(staleJson.symbols).toHaveLength(1);
      expect(staleJson.next_offset).toBe(1);
    } finally {
      await server.close();
      await client.close();
      await controller.stop();
      store.close();
    }
  }, 60_000);

  it("bounds summary source and dependency context without dropping hashes", async () => {
    const { client, server, controller, store } = await connect();
    try {
      const result = await client.callTool({
        name: "get_summary_context",
        arguments: {
          symbol_ids: ["sym:src/App.tsx#App"],
          include_source: true,
          source_chars: 20,
          dependency_limit: 1,
          max_chars: 10_000,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result).length).toBeLessThanOrEqual(10_000);
      const payload = JSON.parse(textOf(result)) as {
        returned: number;
        items: Array<{
          symbol: { content_hash: string };
          hashes: { self: string; dep: string; content: string };
          source: string;
          source_truncated: boolean;
          dependencies: {
            total: number;
            limit: number;
            next_offset: number | null;
            items: Array<Record<string, unknown>>;
          };
        }>;
      };
      const item = payload.items[0]!;
      expect(payload.returned).toBe(1);
      expect(item.source.length).toBeLessThanOrEqual(20);
      expect(item.source_truncated).toBe(true);
      expect(item.hashes.content).toBe(item.symbol.content_hash);
      expect(item.dependencies.items).toHaveLength(1);
      expect(item.dependencies.limit).toBe(1);
      expect(item.dependencies.items[0]).not.toHaveProperty("source_preview");
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
      const symbols = JSON.parse(textOf(lookup)) as {
        symbols: Array<{ content_hash: string; id: string }>;
      };
      const target = symbols.symbols[0]!;
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

      const coverage = await client.callTool({
        name: "get_summary_coverage",
        arguments: { compact: false },
      });
      const coverageJson = JSON.parse(textOf(coverage)) as { synced: number };
      expect(coverageJson.synced).toBe(1);

      const moduleCoverage = await client.callTool({
        name: "get_summary_coverage",
        arguments: { module: "components", compact: false },
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
