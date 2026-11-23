import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TsrayConfig } from "../index/types.js";
import { readJsonFile } from "../util/paths.js";

export interface RunnerCommand {
  available: boolean;
  command: string | null;
  source: string;
  hint?: string;
}

export interface CommandResult {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const MAX_OUTPUT = 200_000;

export async function runCommand(
  cwd: string,
  command: string,
  timeoutMs = 15 * 60 * 1000
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
          cwd,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("/bin/sh", ["-c", command], {
          cwd,
          detached: true,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });

    const terminate = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (!isWindows) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing the shell directly.
        }
      }
      child.kill(signal);
    };

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT) {
        truncated = true;
        return next.slice(0, MAX_OUTPUT);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      setTimeout(() => terminate("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exit_code: exitCode,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout,
        stderr,
        truncated,
      });
    };

    child.on("error", (error) => {
      stderr = append(stderr, Buffer.from(String(error)));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function packageManager(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function scriptCommand(manager: string, script: string): string {
  switch (manager) {
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      return `yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

function localBin(root: string, name: string): string | null {
  const binary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  return fs.existsSync(binary) ? binary : null;
}

function readPackage(root: string): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return readJsonFile(path.join(root, "package.json")) ?? {};
}

export function detectTestRunner(root: string, config: TsrayConfig): RunnerCommand {
  const pkg = readPackage(root);
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const manager = packageManager(root);

  if (config.runner.test) {
    return { available: true, command: config.runner.test, source: "tsray.json runner.test" };
  }

  if (scripts.test) {
    const script = scripts.test;
    const suffix = /vitest/.test(script)
      ? " -- --run"
      : /jest/.test(script)
        ? " -- --ci --watchAll=false"
        : "";
    return {
      available: true,
      command: `${scriptCommand(manager, "test")}${suffix}`,
      source: "package.json#scripts.test",
    };
  }

  if (deps.vitest) {
    const bin = localBin(root, "vitest");
    if (bin) return { available: true, command: `${quote(bin)} run`, source: "vitest devDependency" };
  }
  if (deps.jest) {
    const bin = localBin(root, "jest");
    if (bin) return { available: true, command: `${quote(bin)} --ci`, source: "jest devDependency" };
  }
  if (fs.existsSync(path.join(root, "vitest.config.ts")) || fs.existsSync(path.join(root, "vitest.config.js"))) {
    const bin = localBin(root, "vitest");
    if (bin) return { available: true, command: `${quote(bin)} run`, source: "vitest config" };
  }
  if (fs.existsSync(path.join(root, "jest.config.ts")) || fs.existsSync(path.join(root, "jest.config.js"))) {
    const bin = localBin(root, "jest");
    if (bin) return { available: true, command: `${quote(bin)} --ci`, source: "jest config" };
  }

  return {
    available: false,
    command: null,
    source: "none",
    hint: "Add a test script to package.json, install vitest/jest, or set runner.test in tsray.json.",
  };
}

export function detectTypecheckRunner(root: string, config: TsrayConfig): RunnerCommand {
  const pkg = readPackage(root);
  const scripts = pkg.scripts ?? {};
  const manager = packageManager(root);
  if (config.runner.typecheck) {
    return { available: true, command: config.runner.typecheck, source: "tsray.json runner.typecheck" };
  }
  const script = scripts.typecheck ? "typecheck" : scripts["type-check"] ? "type-check" : null;
  if (script) {
    return {
      available: true,
      command: scriptCommand(manager, script),
      source: `package.json#scripts.${script}`,
    };
  }
  const bin = localBin(root, "tsc");
  if (bin) return { available: true, command: `${quote(bin)} --noEmit`, source: "local tsc" };
  return {
    available: false,
    command: null,
    source: "none",
    hint: "Install typescript or add a typecheck script to package.json.",
  };
}

export function detectLintRunner(root: string, config: TsrayConfig): RunnerCommand {
  const pkg = readPackage(root);
  const scripts = pkg.scripts ?? {};
  const manager = packageManager(root);
  if (config.runner.lint) {
    return { available: true, command: config.runner.lint, source: "tsray.json runner.lint" };
  }
  if (scripts.lint) {
    return { available: true, command: scriptCommand(manager, "lint"), source: "package.json#scripts.lint" };
  }
  if (
    fs.existsSync(path.join(root, "biome.json")) ||
    fs.existsSync(path.join(root, "biome.jsonc"))
  ) {
    const bin = localBin(root, "biome");
    if (bin) return { available: true, command: `${quote(bin)} check .`, source: "biome config" };
  }
  if (
    fs.existsSync(path.join(root, "eslint.config.js")) ||
    fs.existsSync(path.join(root, "eslint.config.mjs")) ||
    fs.existsSync(path.join(root, ".eslintrc")) ||
    fs.existsSync(path.join(root, ".eslintrc.json")) ||
    fs.existsSync(path.join(root, ".eslintrc.cjs"))
  ) {
    const bin = localBin(root, "eslint");
    if (bin) return { available: true, command: `${quote(bin)} .`, source: "eslint config" };
  }
  return {
    available: false,
    command: null,
    source: "none",
    hint: "Add a lint script, install eslint, or install biome.",
  };
}

function quote(value: string): string {
  return /[\s"'$`\\]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
