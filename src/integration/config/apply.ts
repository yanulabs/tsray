import type {
  ConfigAction,
  ConfigChange,
  ConfigLocation,
  McpCommand,
} from "./types.js";
import { validateServerName } from "./args.js";
import { fileMode, readText, writablePath, writeAtomicText } from "./fs.js";
import { hasCodex, installCodex, parseTomlConfig, removeCodexBlocks } from "./codex.js";
import { installJson, loadJson, removeJson, saveJson } from "./json.js";



export function applyMcpConfig(
  location: ConfigLocation,
  action: Exclude<ConfigAction, "status">,
  name: string,
  command: McpCommand,
  options: { dryRun?: boolean } = {}
): ConfigChange {
  validateServerName(name);
  if (location.format === "codex") {
    const file = writablePath(location.path);
    const before = readText(file) ?? "";
    const configured = before.trim() !== "" && hasCodex(before, file, name);
    if (action === "uninstall") {
      if (!configured) {
        return { path: file, format: location.format, before, after: before, changed: false, result: "not_configured" };
      }
      const after = `${removeCodexBlocks(before, name).trimEnd()}${before.trim() ? "\n" : ""}`;
      if (after.trim()) parseTomlConfig(after, file);
      if (!options.dryRun) writeAtomicText(file, after, fileMode(file));
      return { path: file, format: location.format, before, after, changed: true, result: "removed" };
    }
    const rendered = installCodex(file, name, command);
    const changed = rendered.before !== rendered.after;
    if (!options.dryRun && changed) writeAtomicText(file, rendered.after, fileMode(file));
    return {
      path: file,
      format: location.format,
      before: rendered.before,
      after: rendered.after,
      changed,
      result: changed ? "installed" : "already_installed",
    };
  }

  const { data, mode, before } = loadJson(location.path);
  if (action === "uninstall") {
    const removed = removeJson(data, location.format, name);
    if (!removed) {
      return { path: writablePath(location.path), format: location.format, before, after: before, changed: false, result: "not_configured" };
    }
    const after = options.dryRun ? `${JSON.stringify(data, null, 2)}\n` : saveJson(location.path, data, mode);
    return { path: writablePath(location.path), format: location.format, before, after, changed: true, result: "removed" };
  }

  installJson(data, location.format, name, command);
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  const changed = before !== rendered;
  if (!options.dryRun && changed) saveJson(location.path, data, mode);
  return {
    path: writablePath(location.path),
    format: location.format,
    before,
    after: rendered,
    changed,
    result: changed ? "installed" : "already_installed",
  };
}
