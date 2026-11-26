import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DualCacheStore } from "../cache/store.js";
import type { IndexController } from "../index/watch.js";
import { registerArchitectureTools } from "./domains/architecture.js";
import { registerAuditTools } from "./domains/audit.js";
import { registerCommandTools } from "./domains/commands.js";
import { registerCssTools } from "./domains/css.js";
import { registerMaintenanceTools } from "./domains/maintenance.js";
import { registerProjectTools } from "./domains/project.js";
import { registerReactTools } from "./domains/react.js";
import { registerSummaryTools } from "./domains/summaries.js";
import { registerSymbolTools } from "./domains/symbols.js";
import { createToolContext } from "./shared/context.js";

/**
 * MCP composition root. Each domain owns its schemas and projections; this file
 * only wires them to one server and returns the registered tool names.
 */
export function registerMcpTools(
  server: McpServer,
  controller: IndexController,
  store: DualCacheStore
): string[] {
  const context = createToolContext(server, controller, store);

  registerProjectTools(context);
  registerArchitectureTools(context);
  registerSymbolTools(context);
  registerReactTools(context);
  registerAuditTools(context);
  registerSummaryTools(context);
  registerCommandTools(context);
  registerCssTools(context);
  registerMaintenanceTools(context);

  return context.toolNames;
}
