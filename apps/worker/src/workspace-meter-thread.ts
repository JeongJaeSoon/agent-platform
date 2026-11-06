import { parentPort, workerData } from "node:worker_threads";
import { scanWorkspace } from "./workspace-meter.ts";

const { root, budgetMs } = workerData as { root: string; budgetMs: number };
const measurement = scanWorkspace(root, budgetMs, (measurement) => {
  parentPort?.postMessage({ done: false, measurement });
});
parentPort?.postMessage({ done: true, measurement });
