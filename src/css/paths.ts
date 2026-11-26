import path from "node:path";
import { toPosix } from "../util/paths.js";

export function relativePosix(root: string, file: string): string {
  return toPosix(path.relative(root, file));
}
