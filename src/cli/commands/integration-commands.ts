import {
  runMcpIntegration,
  runSkillIntegration,
} from "../integration.js";
import {
  boolValue,
  stringValue,
  type CliValues,
} from "../command-context.js";

export async function handleIntegrationCommand(
  command: string,
  rest: string[],
  values: CliValues
): Promise<boolean> {
  if (
    command === "install-mcp" ||
    command === "uninstall-mcp" ||
    command === "mcp-status"
  ) {
    const targetValue =
      stringValue(values.target) ?? process.env.TSRAY_MCP_TARGET;
    const targets = [
      ...rest,
      ...(targetValue ? [targetValue] : []),
      ...(boolValue(values.all) ? ["all"] : []),
    ];
    process.exitCode = await runMcpIntegration({
      action:
        command === "install-mcp"
          ? "install"
          : command === "uninstall-mcp"
            ? "uninstall"
            : "status",
      targets,
      scope: (stringValue(values.scope) ??
        process.env.TSRAY_MCP_SCOPE ??
        "global") as "global" | "project",
      name: stringValue(values.name) ?? process.env.TSRAY_MCP_NAME ?? "tsray",
      format: stringValue(values.format) ?? process.env.TSRAY_MCP_FORMAT,
      configPath: stringValue(values.config) ?? process.env.TSRAY_MCP_CONFIG,
      command: stringValue(values.command) ?? process.env.TSRAY_MCP_COMMAND,
      args: stringValue(values.args) ?? process.env.TSRAY_MCP_ARGS ?? "serve",
      cwd: stringValue(values.cwd) ?? process.env.TSRAY_MCP_CWD,
      projectRoot:
        stringValue(values["project-root"]) ??
        process.env.TSRAY_PROJECT_ROOT ??
        process.cwd(),
      dryRun: boolValue(values["dry-run"]),
      yes: boolValue(values.yes),
      interactive: process.stdin.isTTY,
    });
    return true;
  }

  if (
    command === "install-skill" ||
    command === "uninstall-skill" ||
    command === "skill-status"
  ) {
    const targetValue =
      stringValue(values.target) ?? process.env.TSRAY_SKILL_TARGET;
    const targets = [
      ...rest,
      ...(targetValue ? [targetValue] : []),
      ...(boolValue(values.all) ? ["all"] : []),
    ];
    process.exitCode = await runSkillIntegration({
      action:
        command === "install-skill"
          ? "install"
          : command === "uninstall-skill"
            ? "uninstall"
            : "status",
      targets,
      scope: (stringValue(values.scope) ??
        process.env.TSRAY_SKILL_SCOPE ??
        "global") as "global" | "project",
      name: stringValue(values.name) ?? process.env.TSRAY_SKILL_NAME ?? "tsray",
      directory: stringValue(values.dir) ?? process.env.TSRAY_SKILL_DIR,
      mode: (stringValue(values.mode) ??
        process.env.TSRAY_SKILL_MODE ??
        "copy") as "copy" | "link",
      projectRoot:
        stringValue(values["project-root"]) ??
        process.env.TSRAY_PROJECT_ROOT ??
        process.cwd(),
      dryRun: boolValue(values["dry-run"]),
      yes: boolValue(values.yes),
      interactive: process.stdin.isTTY,
    });
    return true;
  }

  return false;
}
