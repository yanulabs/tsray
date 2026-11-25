import fs from "node:fs";
import { workerData } from "node:worker_threads";
import {
  TsReactIndexer,
  type ProjectWorkerOutput,
  type ProjectWorkerTask,
  type SerializedProjectIndex,
} from "./indexer.js";

interface WorkerData extends ProjectWorkerTask {
  signal: SharedArrayBuffer;
  signalIndex: number;
  outputPath: string;
  queue: SharedArrayBuffer;
}

const data = workerData as WorkerData;
const signals = new Int32Array(data.signal);
const signalOffset = data.signalIndex * 2;
let output: ProjectWorkerOutput;

try {
  Atomics.store(signals, signalOffset, 1);
  Atomics.notify(signals, signalOffset);

  const indexer = TsReactIndexer.fromBootstrap(data.bootstrap);
  indexer.restrictToProjects(data.projects.map((project) => project.path));

  const results: SerializedProjectIndex[] = [];
  const queue = new Int32Array(data.queue);
  while (true) {
    const projectIndex = Atomics.add(queue, 0, 1);
    const project = data.projects[projectIndex];
    if (!project) break;
    results.push(indexer.buildProjectIndex(project.path, data.fullDiagnostics));
  }
  output = { results };
} catch (error) {
  output = { error: error instanceof Error ? error.message : String(error) };
}

try {
  fs.writeFileSync(data.outputPath, JSON.stringify(output));
} finally {
  Atomics.store(signals, signalOffset, 2);
  Atomics.notify(signals, signalOffset);
}
