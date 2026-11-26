import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigError } from "./types.js";

export function writablePath(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(file);
      } catch (error) {
        throw new ConfigError(`${file}: broken symlink: ${String(error)}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file}: ${String(error)}`);
  }
}

export function fileMode(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file}: ${String(error)}`);
  }
}

export function writeAtomicText(file: string, text: string, mode: number | null): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", mode ?? 0o600);
  try {
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fchmodSync(descriptor, mode ?? 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    try {
      fs.copyFileSync(temporary, file);
      fs.chmodSync(file, mode ?? 0o600);
      fs.rmSync(temporary, { force: true });
    } catch (copyError) {
      fs.rmSync(temporary, { force: true });
      throw copyError;
    }
  }
}
