#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli
  ? [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`Could not parse npm pack output: ${String(error)}`, { cause: error });
}
const [manifest] = payload;
if (!manifest || !Array.isArray(manifest.files)) throw new Error("npm pack returned no file manifest");

const paths = new Set(manifest.files.map((file) => file.path));
const required = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/cli/index.js",
  "web/dist/report.html",
  ".opencode/skills/tsray/SKILL.md",
  "licenses/elkjs-EPL-2.0.txt",
  "licenses/React-MIT.txt",
  "licenses/Tailwind-MIT.txt",
];
const missing = required.filter((file) => !paths.has(file));
if (missing.length > 0) throw new Error(`Package is missing required files: ${missing.join(", ")}`);

const forbidden = [
  /^\.env(?:\.|$)/,
  /^\.npmrc$/,
  /^\.git\//,
  /(?:^|\/)node_modules\//,
  /^test\//,
  /\.(?:db|sqlite|sqlite3|pem|key|p12)$/i,
];
const unexpected = [...paths].filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (unexpected.length > 0) {
  throw new Error(`Package contains forbidden files: ${unexpected.join(", ")}`);
}

const cli = manifest.files.find((file) => file.path === "dist/cli/index.js");
if (process.platform !== "win32" && (!cli || (cli.mode & 0o111) === 0)) {
  throw new Error("Packaged CLI is not executable");
}

const map = JSON.parse(fs.readFileSync("dist/cli/index.js.map", "utf8"));
if (!Array.isArray(map.sourcesContent) || map.sourcesContent.some((source) => source == null)) {
  throw new Error("Published source maps must embed their original source text");
}

process.stdout.write(
  `Package manifest verified: ${manifest.files.length} files, ${manifest.size} bytes packed, ${manifest.unpackedSize} bytes unpacked.\n`
);
