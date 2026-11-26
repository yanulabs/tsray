import { execFileSync } from "node:child_process";
import { GitDiffError } from "./errors.js";

export function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new GitDiffError(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export function cycleKey(cycle: string[]): string {
  return cycle.join("->");
}
