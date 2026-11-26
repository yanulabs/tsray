export function parseSummary(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function kindOrder(kind: string): number {
  switch (kind) {
    case "interface":
    case "type":
    case "class":
    case "enum":
      return 0;
    case "context":
      return 1;
    case "hook":
      return 2;
    case "function":
    case "method":
      return 3;
    case "component":
      return 4;
    default:
      return 5;
  }
}
