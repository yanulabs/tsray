import fs from "node:fs";
import path from "node:path";
import { toPosix } from "../../util/paths.js";
import { GitDiffError } from "./errors.js";
import { git } from "./git.js";

function isWorkspaceSourceTarget(mainRoot: string, target: string): boolean {
  const relative = path.relative(mainRoot, target);
  return !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    relative !== "node_modules" &&
    !relative.startsWith(`node_modules${path.sep}`);
}

function containsWorkspaceLink(directory: string, mainRoot: string, depth = 0): boolean {
  if (depth > 4) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (isWorkspaceSourceTarget(mainRoot, fs.realpathSync(sourcePath))) return true;
      } catch {
        // Ignore broken optional links.
      }
    } else if (entry.isDirectory() && entry.name !== ".pnpm" && containsWorkspaceLink(sourcePath, mainRoot, depth + 1)) {
      return true;
    }
  }
  return false;
}

function mirrorNodeModules(
  mainRoot: string,
  worktreeRoot: string,
  source: string,
  destination: string
): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (fs.existsSync(destinationPath)) continue;
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(sourcePath);
      } catch {
        // Ignore broken optional links.
        continue;
      }
      const relative = path.relative(mainRoot, target);
      if (isWorkspaceSourceTarget(mainRoot, target)) {
        const remapped = path.join(worktreeRoot, relative);
        if (!fs.existsSync(remapped)) continue;
        target = remapped;
      }
      try {
        fs.symlinkSync(target, destinationPath);
      } catch {
        // Broken optional links do not prevent indexing tracked source files.
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name.startsWith("@") || containsWorkspaceLink(sourcePath, mainRoot)) {
        mirrorNodeModules(mainRoot, worktreeRoot, sourcePath, destinationPath);
      } else {
        try {
          fs.symlinkSync(sourcePath, destinationPath, process.platform === "win32" ? "junction" : "dir");
        } catch {
          // A recursive fallback keeps platforms without directory links working.
          mirrorNodeModules(mainRoot, worktreeRoot, sourcePath, destinationPath);
        }
      }
      continue;
    }
    try {
      fs.symlinkSync(sourcePath, destinationPath, "file");
    } catch {
      // Ignore optional node_modules metadata files.
    }
  }
}

function linkWorkspaceNodeModules(mainRoot: string, worktreeRoot: string): void {
  const pending = [mainRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const relative = path.relative(mainRoot, directory);
    const destination = path.join(worktreeRoot, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const source = path.join(directory, entry.name);
      const target = path.join(destination, entry.name);
      if (entry.name === "node_modules") {
        mirrorNodeModules(mainRoot, worktreeRoot, source, target);
        continue;
      }
      if (entry.isDirectory() && fs.existsSync(target)) pending.push(source);
    }
  }
}

export function assertTrackedConfigsDiscovered(worktreeRoot: string, baseTarget: string, tsconfigPaths: string[]): void {
  const discovered = new Set(tsconfigPaths);
  const missing: string[] = [];
  for (const file of git(worktreeRoot, ["ls-files"]).split("\n")) {
    if (!file || !path.basename(file).startsWith("tsconfig") || !file.endsWith(".json")) continue;
    const absolute = path.join(worktreeRoot, file);
    const relative = path.relative(baseTarget, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!discovered.has(toPosix(relative))) missing.push(toPosix(relative));
  }
  if (missing.length > 0) {
    throw new GitDiffError(`base worktree discovery missed tracked tsconfigs: ${missing.slice(0, 5).join(", ")}`);
  }
}

/** @internal Shared by diff integration tests and diagnostics. */
function mirrorGeneratedOutputs(mainRoot: string, worktreeRoot: string): void {
  const generatedDirectories = new Set(["dist", "lib", "build", "out"]);
  const mirror = (source: string, destination: string): void => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory() && generatedDirectories.has(entry.name)) {
        if (!fs.existsSync(destinationPath)) {
          try {
            fs.symlinkSync(sourcePath, destinationPath, process.platform === "win32" ? "junction" : "dir");
          } catch {
            // Generated output is optional when directory links are unavailable.
          }
        }
      } else if (entry.isDirectory()) {
        if (fs.existsSync(destinationPath)) mirror(sourcePath, destinationPath);
      } else if (
        entry.name.startsWith("tsconfig") &&
        entry.name.endsWith(".json") &&
        !fs.existsSync(destinationPath)
      ) {
        const relative = path.relative(source, sourcePath);
        try {
          git(source, ["ls-files", "--error-unmatch", relative]);
        } catch {
          fs.copyFileSync(sourcePath, destinationPath);
        }
      }
    }
  };

  for (const line of git(mainRoot, ["submodule", "status", "--recursive"]).split("\n")) {
    const match = line.match(/^[\s+-]?([0-9a-f]+)\s+(\S+)/);
    if (!match) continue;
    const [, commit, relative] = match;
    const source = path.join(mainRoot, relative!);
    const destination = path.join(worktreeRoot, relative!);
    if (!fs.existsSync(source) || !fs.existsSync(destination)) continue;
    try {
      if (git(destination, ["rev-parse", "HEAD"]) === commit) mirror(source, destination);
    } catch {
      // Uninitialized or changed submodules are handled by submodule update.
    }
  }
}

/** @internal Shared by diff integration tests and diagnostics. */
export function prepareBaseWorktree(mainRoot: string, worktreeRoot: string, baseTarget: string): void {
  git(worktreeRoot, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--checkout"]);
  const status = git(worktreeRoot, ["submodule", "status", "--recursive"]);
  if (status.split("\n").some((line) => line.startsWith("-"))) {
    throw new GitDiffError("base worktree has uninitialized submodules; refusing a partial diff");
  }
  mirrorGeneratedOutputs(mainRoot, worktreeRoot);
  linkWorkspaceNodeModules(mainRoot, worktreeRoot);
  if (!fs.existsSync(path.join(baseTarget, "pnpm-workspace.yaml")) && !fs.existsSync(path.join(baseTarget, "package.json"))) {
    throw new GitDiffError(`base worktree target is missing workspace metadata: ${baseTarget}`);
  }
}
