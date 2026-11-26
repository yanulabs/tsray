import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { DualCacheStore } from "../../cache/store.js";
import { CssAnalysisService } from "../../css/service.js";
import type { IndexController } from "../../index/watch.js";
import type { ToolArgs } from "./args.js";
import { errorResult } from "./results.js";

export type ToolHandler = (args: ToolArgs) => Promise<CallToolResult>;

export type RegisterTool = (
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: ToolHandler
) => void;

export interface ToolContext {
  controller: IndexController;
  store: DualCacheStore;
  cssAnalysis: CssAnalysisService;
  register: RegisterTool;
  /** Mutable registry populated by every domain module. */
  toolNames: string[];
}

/**
 * Shared infrastructure for all MCP domains. Registration, error wrapping, and
 * the CSS analysis cache live here so individual tools stay focused on their
 * domain query and projection.
 */
export function createToolContext(
  server: McpServer,
  controller: IndexController,
  store: DualCacheStore
): ToolContext {
  const toolNames: string[] = [];
  const register: RegisterTool = (name, description, inputSchema, handler) => {
    toolNames.push(name);
    server.registerTool(
      name,
      {
        description,
        inputSchema,
      },
      async (args) => {
        try {
          return await handler((args ?? {}) as ToolArgs);
        } catch (error) {
          return errorResult({
            error: "tool_failed",
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
  };

  return {
    controller,
    store,
    cssAnalysis: new CssAnalysisService(controller.indexer),
    register,
    toolNames,
  };
}
