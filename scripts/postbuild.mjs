#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli", "index.js");

if (fs.existsSync(cli)) {
  fs.chmodSync(cli, 0o755);
  process.stdout.write(`Made ${path.relative(root, cli)} executable\n`);
}
