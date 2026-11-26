import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = path.resolve(import.meta.dirname, "..");
const apiTarget = process.env.TSRAY_DEV_API ?? "http://127.0.0.1:4321";

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8").trim();
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function licenseNotices(): Plugin {
  const rootPackage = readJson("package.json");
  const webLock = readJson("web/package-lock.json") as {
    packages: Record<string, { version?: string }>;
  };
  const versionOf = (name: string): string => {
    const version = webLock.packages[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`Missing locked version for ${name}`);
    return version;
  };
  const reactVersion = versionOf("react");
  const reactDomVersion = versionOf("react-dom");
  const schedulerVersion = versionOf("scheduler");
  const tailwindVersion = versionOf("tailwindcss");
  const elkVersion = versionOf("elkjs");
  const notices = {
    [`tsray ${String(rootPackage.version)}`]: { license: "MIT", text: readText("LICENSE") },
    [`React ${reactVersion} / React DOM ${reactDomVersion} / Scheduler ${schedulerVersion}`]: {
      license: "MIT",
      text: readText("licenses/React-MIT.txt"),
    },
    [`Tailwind CSS ${tailwindVersion}`]: { license: "MIT", text: readText("licenses/Tailwind-MIT.txt") },
    [`elkjs ${elkVersion}`]: {
      license: "EPL-2.0",
      text: readText("licenses/elkjs-EPL-2.0.txt"),
      sourceCode: `https://github.com/kieler/elkjs/tree/${elkVersion}`,
      sourceArchive: `https://github.com/kieler/elkjs/archive/${elkVersion}.tar.gz`,
    },
  };

  return {
    name: "tsray-license-notices",
    transformIndexHtml(html) {
      const json = JSON.stringify(notices).replace(/</g, "\\u003c");
      const tag = `<script id="tsray-licenses" type="application/json">${json}</script>`;
      if (!html.includes("</head>")) throw new Error("Report HTML is missing </head>");
      return html.replace("</head>", `${tag}</head>`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [licenseNotices(), react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: "report.html",
    },
  },
});
