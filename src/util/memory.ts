import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const GB = 1024 ** 3;

function readNumber(file: string): number | null {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value === "max" || value.length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function processCgroupV2Path(): string | null {
  try {
    const line = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find((entry) => entry.startsWith("0::"));
    return line?.slice(3) || null;
  } catch {
    return null;
  }
}

function linuxAvailableMemory(): number | null {
  const subgroup = processCgroupV2Path();
  const v2Limits = [
    subgroup ? `/sys/fs/cgroup${subgroup}/memory.max` : null,
    "/sys/fs/cgroup/memory.max",
  ].filter((file): file is string => Boolean(file));
  for (const limitFile of v2Limits) {
    const limit = readNumber(limitFile);
    if (limit === null) continue;
    const current = readNumber(limitFile.replace(/memory\.max$/, "memory.current"));
    return Math.max(0, limit - (current ?? 0));
  }

  const v1Limit = readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1Limit !== null && v1Limit < os.totalmem()) {
    const current = readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes") ?? 0;
    return Math.max(0, v1Limit - current);
  }
  return null;
}

function macosAvailableMemory(): number | null {
  try {
    const output = execFileSync("/usr/bin/vm_stat", [], { encoding: "utf8", timeout: 1000 });
    const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (label: string): number => Number(output.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * pageSize;
  } catch {
    return null;
  }
}

/** Memory currently available to tsray, including Linux container limits. */
export function availableMemoryBytes(): number {
  if (process.platform === "linux") {
    const container = linuxAvailableMemory();
    if (container !== null) return container;
  }
  const total = os.totalmem();
  const reclaimable = process.platform === "darwin" ? macosAvailableMemory() : null;
  const free = reclaimable ?? Math.max(os.freemem(), total * 0.2);
  const headroom = process.platform === "darwin" || process.platform === "win32" ? total * 0.15 : total * 0.05;
  return Math.max(0, free - headroom);
}

/** Pure worker-count calculation kept separate for deterministic tests. */
export function calculateWorkerCount(
  availableBytes: number,
  projectCount: number,
  override?: number
): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.min(projectCount, Math.floor(override)));
  }
  const headroom = 1.5 * GB;
  const memoryWorkers = Math.floor((Math.max(0, availableBytes) - headroom) / (2 * GB));
  return Math.max(1, Math.min(projectCount, 8, memoryWorkers));
}

export function defaultWorkerCount(projectCount: number, override?: number): number {
  return calculateWorkerCount(availableMemoryBytes(), projectCount, override);
}
