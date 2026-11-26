import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { defaultWorkerCount } from "../../util/memory.js";
import type {
  IndexerBootstrap,
  ParsedProject,
  ProjectWorkerOutput,
  SerializedProjectIndex,
} from "./types.js";

export function workerScriptExists(): boolean {
  try {
    return fs.existsSync(fileURLToPath(new URL("./worker.js", import.meta.url)));
  } catch {
    return false;
  }
}

export function indexProjectsInParallel(
  selectedProjects: ParsedProject[],
  fullDiagnostics: boolean,
  bootstrap: IndexerBootstrap
): { results: Map<string, SerializedProjectIndex>; workersSpawned: number } {
    const results = new Map<string, SerializedProjectIndex>();
    const projects = [...selectedProjects].sort(
      (a, b) => b.programFiles.length - a.programFiles.length || a.path.localeCompare(b.path)
    );
    const configuredValue = Number(process.env.TSRAY_WORKERS ?? 0);
    const configured = Number.isFinite(configuredValue) && configuredValue > 0 ? configuredValue : undefined;
    const workerCount = defaultWorkerCount(projects.length, configured);
    if (workerCount < 1) return { results, workersSpawned: 0 };

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-index-"));
    const signals = new Int32Array(
      new SharedArrayBuffer(workerCount * 2 * Int32Array.BYTES_PER_ELEMENT)
    );
    const queue = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const workers: Worker[] = [];
    const outputPaths: string[] = [];
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    const common = {
      bootstrap: bootstrap,
      projects: projects.map((project) => ({ path: project.path })),
      fullDiagnostics,
    };

    try {
      for (let index = 0; index < workerCount; index++) {
        const outputPath = path.join(temporary, `${index}.json`);
        outputPaths[index] = outputPath;
        const worker = new Worker(workerPath, {
          workerData: {
            ...common,
            signal: signals.buffer,
            signalIndex: index,
            outputPath,
            queue: queue.buffer,
          },
        });
        // Errors are reported through the result file. The listener prevents an
        // unhandled error while the main thread is synchronously waiting.
        worker.on("error", () => {});
        workers.push(worker);
      }

      const startupDeadline = Date.now() + 30_000;
      for (let index = 0; index < workers.length; index++) {
        const remaining = Math.max(0, startupDeadline - Date.now());
        if (Atomics.wait(signals, index * 2, 0, remaining) === "timed-out") continue;
      }
      const completionDeadline = Date.now() + 900_000;
      for (let index = 0; index < workers.length; index++) {
        if (Atomics.load(signals, index * 2) === 0) continue;
        const remaining = Math.max(0, completionDeadline - Date.now());
        if (Atomics.wait(signals, index * 2, 1, remaining) === "timed-out") continue;
      }

      for (let index = 0; index < workers.length; index++) {
        if (Atomics.load(signals, index * 2) !== 2) continue;
        const outputPath = outputPaths[index];
        if (!outputPath || !fs.existsSync(outputPath)) continue;
        try {
          const output = JSON.parse(fs.readFileSync(outputPath, "utf8")) as ProjectWorkerOutput;
          for (const result of output.results ?? []) results.set(result.projectPath, result);
        } catch {
          // The parent indexes any missing project sequentially below.
        }
      }
    } finally {
      for (const worker of workers) void worker.terminate();
      fs.rmSync(temporary, { recursive: true, force: true });
    }

    return { results, workersSpawned: workers.length };
  }
