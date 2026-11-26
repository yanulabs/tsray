import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonToolResult, textToolResult } from "../response.js";

export function jsonResult(
  value: unknown,
  maxChars = Number.POSITIVE_INFINITY
): CallToolResult {
  return jsonToolResult(value, maxChars);
}

export function textResult(
  text: string,
  maxChars = Number.POSITIVE_INFINITY
): CallToolResult {
  return textToolResult(text, maxChars);
}

export function errorResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}
